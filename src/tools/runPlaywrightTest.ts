import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { findProjectRoot, resolveInProjectRoot } from "../lib/config.js";
import { flattenSuites, HEALING_GATE_DIRECTIVE, type PwJsonReport, type TestFailureDetail } from "../lib/playwrightReport.js";
import { scoreSpecAndRelatedPOMFiles, type ComprehensiveQualityScore } from "../lib/scoreContent.js";
import { generateQualityHtmlReport } from "../lib/htmlQualityReport.js";
import { createRunReportDirectory, discardRunReportDirectory, registerRunReport } from "../lib/reportRegistry.js";
import { checkTestPrerequisites, type TestPrerequisites } from "../lib/prerequisites.js";
import { classifyRunnerOutcome, type RunnerError, type SuiteStatus } from "../lib/runnerClassification.js";
import { runRunnerProcess, validateRunnerTimeout } from "../lib/runnerProcess.js";
import { prepareRunConfig, type ReporterStrategy } from "../lib/runConfig.js";
import { enrichFailureDetail } from "../lib/failureDiagnostics.js";
import {
  boundRunnerText,
  compactQualityScore,
  fitToBudget,
  shapeFailure,
  shapeTests,
  type CompactQualityScore,
  type CompactTest,
  type DetailLevel,
  OUTPUT_BUDGET,
} from "../lib/runOutput.js";

/** JSON reports larger than this are rejected instead of being parsed into memory. */
export const MAX_REPORT_BYTES = 50 * 1024 * 1024;

export const runPlaywrightTestInputShape = {
  specPath: z.string().describe("Path to the spec file, relative to project root or absolute, e.g. \"e2e/payment.spec.ts\"."),
  projectRoot: z
    .string()
    .optional()
    .describe("Optional path to the target project root. If omitted, auto-detected by searching for playwright.config.*."),
  grep: z.string().optional().describe("Only run tests whose title matches this pattern (passed to --grep)."),
  headed: z.boolean().optional().describe("Run in headed (visible browser) mode instead of headless."),
  generateHtmlReport: z
    .boolean()
    .optional()
    .describe("Set to true to generate the standalone visual quality report at test-results/quality-report.html."),
  timeoutMs: z.number().int().min(100).max(900_000).optional().describe("Maximum runner duration in milliseconds (default 120000; allowed range 100–900000)."),
  detail: z
    .enum(["summary", "full"])
    .optional()
    .describe(
      "Response size. 'summary' (default) returns status, counts, up to 5 failures with bounded diagnostics and artifact paths. " +
        "'full' adds every test with retry attempts, runner stdout/stderr and the complete quality score. Prefer get_failure_details for one test.",
    ),
};

export const runPlaywrightTestSchema = z.object(runPlaywrightTestInputShape);
export type RunPlaywrightTestInput = z.infer<typeof runPlaywrightTestSchema>;

export interface RunnerSummary {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  timeoutMs: number;
  reporterStrategy: ReporterStrategy;
  /** Reporters configured by the project that ran alongside the MCP JSON reporter. */
  preservedReporters?: string[];
  reporterFallbackReason?: string;
  spawnError?: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  stderrTail?: string;
  stdout?: string;
  stderr?: string;
}

export interface NativeReports {
  htmlReportPath?: string;
  allureResultsPath?: string;
}

export interface RunPlaywrightTestOutput {
  status: SuiteStatus | "setup_required";
  detail: DetailLevel;
  /** Absolute project root. Artifact paths inside it are returned relative to it to save tokens. */
  projectRoot: string;
  durationMs: number;
  summary: {
    total: number;
    passed: number;
    failed: number;
    timedout: number;
    interrupted: number;
    flaky: number;
    skipped: number;
  };
  runnerError?: RunnerError;
  failures?: TestFailureDetail[];
  failuresOmitted?: number;
  tests: CompactTest[];
  testsOmitted?: number;
  runner?: RunnerSummary;
  reportPath?: string;
  traceZipPath?: string;
  videoPath?: string;
  nativeReports?: NativeReports;
  qualityScore?: CompactQualityScore | ComprehensiveQualityScore;
  qualityReportHtmlPath?: string;
  healingGateDirective?: string;
  reportPromptDirective?: string;
  prerequisites?: TestPrerequisites;
  outputBudget?: { maxChars: number; reduced: boolean };
}

export interface RunPlaywrightTestOptions {
  /** Aborts the run (e.g. MCP request cancellation). */
  signal?: AbortSignal;
}

/** Express a path relative to the project root when it is inside it; other paths stay absolute. */
function relativeToRoot(projectRoot: string, filePath: string | undefined): string | undefined {
  if (!filePath || !path.isAbsolute(filePath)) return filePath;
  const relative = path.relative(projectRoot, filePath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : filePath;
}

function relativizeFailure(projectRoot: string, failure: TestFailureDetail): TestFailureDetail {
  const relative = (filePath: string | undefined) => relativeToRoot(projectRoot, filePath);
  return {
    ...failure,
    ...(failure.location ? { location: { ...failure.location, file: relative(failure.location.file) } } : {}),
    screenshotPath: relative(failure.screenshotPath),
    traceZipPath: relative(failure.traceZipPath),
    videoPath: relative(failure.videoPath),
    errorContextPath: relative(failure.errorContextPath),
  };
}

const EMPTY_SUMMARY = { total: 0, passed: 0, failed: 0, timedout: 0, interrupted: 0, flaky: 0, skipped: 0 };
const DIAGNOSED_FAILURES_LIMIT = 10;

function readReport(jsonReportPath: string): { report?: PwJsonReport; reportReadError?: string } {
  if (!existsSync(jsonReportPath)) return {};
  try {
    if (statSync(jsonReportPath).size > MAX_REPORT_BYTES) {
      throw new Error(`JSON report exceeds ${MAX_REPORT_BYTES} bytes.`);
    }
    const parsed: unknown = JSON.parse(readFileSync(jsonReportPath, "utf-8"));
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { suites?: unknown }).suites)) {
      throw new Error("JSON report must contain a suites array.");
    }
    return { report: parsed as PwJsonReport };
  } catch (error) {
    return { reportReadError: error instanceof Error ? error.message : String(error) };
  }
}

type ReporterEntry = [string, Record<string, unknown> | null | undefined];

function configuredReporters(report: PwJsonReport | undefined): ReporterEntry[] {
  const reporters = (report?.config as { reporter?: unknown } | undefined)?.reporter;
  return Array.isArray(reporters) ? (reporters.filter((entry) => Array.isArray(entry) && typeof entry[0] === "string") as ReporterEntry[]) : [];
}

/** Locate native reports produced by reporters the project configured, now that they are preserved. */
function locateNativeReports(reporters: ReporterEntry[], configDirectory: string, projectRoot: string): NativeReports | undefined {
  const result: NativeReports = {};
  const html = reporters.find(([name]) => name === "html");
  if (html) {
    const folder = typeof html[1]?.outputFolder === "string" ? html[1].outputFolder : process.env.PLAYWRIGHT_HTML_OUTPUT_DIR ?? "playwright-report";
    const index = path.resolve(configDirectory, folder, "index.html");
    if (existsSync(index)) result.htmlReportPath = index;
  }
  const allure = reporters.find(([name]) => /allure-playwright/.test(name));
  if (allure) {
    const folder = typeof allure[1]?.resultsDir === "string" ? allure[1].resultsDir : "allure-results";
    const resultsPath = path.resolve(projectRoot, folder);
    if (existsSync(resultsPath)) result.allureResultsPath = resultsPath;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export async function runPlaywrightTest(
  input: RunPlaywrightTestInput,
  options: RunPlaywrightTestOptions = {},
): Promise<RunPlaywrightTestOutput> {
  const level: DetailLevel = input.detail ?? "summary";
  const projectRoot = findProjectRoot(undefined, input.projectRoot);
  const absoluteSpecPath = resolveInProjectRoot(input.specPath, projectRoot, { expectedType: "file" });
  if (!existsSync(absoluteSpecPath)) {
    throw new Error(`Spec file not found: ${input.specPath}`);
  }

  const prerequisites = checkTestPrerequisites(projectRoot);
  if (!prerequisites.playwright.ready) {
    return {
      status: "setup_required",
      detail: level,
      projectRoot,
      durationMs: 0,
      summary: EMPTY_SUMMARY,
      tests: [],
      prerequisites,
      reportPromptDirective:
        "Playwright was not run because the target project is not ready. Follow prerequisites.nextSteps, then run the test again.",
    };
  }

  const timeoutMs = validateRunnerTimeout(input.timeoutMs);
  const reportDir = createRunReportDirectory();
  const jsonReportPath = path.join(reportDir, "report.json");
  const runConfig = prepareRunConfig({ configPath: prerequisites.playwright.configPath, jsonReportPath });

  const relativeSpecToRoot = path.relative(projectRoot, absoluteSpecPath);
  const args = ["test", relativeSpecToRoot, ...runConfig.args];
  if (input.grep) args.push("--grep", input.grep);
  if (input.headed) args.push("--headed");

  let runner: Awaited<ReturnType<typeof runRunnerProcess>>;
  try {
    runner = await runRunnerProcess(process.execPath, [prerequisites.playwright.cliPath!, ...args], {
      cwd: projectRoot,
      env: { ...process.env, ...runConfig.env },
      timeoutMs,
      signal: options.signal,
    });
  } finally {
    runConfig.cleanup();
  }
  const durationMs = runner.durationMs;

  const { report, reportReadError } = readReport(jsonReportPath);
  if (report) registerRunReport(reportDir, jsonReportPath);
  else discardRunReportDirectory(reportDir);

  const flatTests = flattenSuites(report?.suites ?? []);
  const classification = classifyRunnerOutcome({
    process: runner,
    report,
    reportReadError,
    reportExists: report !== undefined || reportReadError !== undefined,
    tests: flatTests,
  });
  const status = classification.status;

  const count = (value: string) => flatTests.filter((t) => t.status === value).length;
  const summary = {
    total: flatTests.length,
    passed: count("passed"),
    failed: count("failed"),
    timedout: count("timedout"),
    interrupted: count("interrupted"),
    flaky: count("flaky"),
    skipped: count("skipped"),
  };

  // Attachments come from the report this run just produced, so their paths are trusted.
  const canReadPath = (filePath: string) => path.isAbsolute(filePath) && existsSync(filePath);
  const failingTests = flatTests.filter((t) => t.failureDetail !== undefined);
  const failures: TestFailureDetail[] = failingTests.map((test, index) =>
    index < DIAGNOSED_FAILURES_LIMIT ? enrichFailureDetail(test.failureDetail!, test, { canReadPath }) : test.failureDetail!,
  );

  const allAttachments = flatTests.flatMap((t) => (t.failedAttemptAttachments.length > 0 ? t.failedAttemptAttachments : t.attachments));
  const traceAttachment = allAttachments.find((a) => a.name === "trace" || a.path?.endsWith(".zip"));
  const videoAttachment = allAttachments.find((a) => a.name === "video" || a.path?.endsWith(".webm"));

  // The wrapper appends the MCP JSON reporter last; everything before it is the project's own.
  const projectReporters = runConfig.strategy === "config_wrapper" ? configuredReporters(report).slice(0, -1) : [];
  const preservedReporters = projectReporters.map(([name]) => name);
  const configDirectory = prerequisites.playwright.configPath ? path.dirname(prerequisites.playwright.configPath) : projectRoot;
  const nativeReports = locateNativeReports(projectReporters, configDirectory, projectRoot);

  let qualityScore: ComprehensiveQualityScore | undefined;
  let qualityReportHtmlPath: string | undefined;
  try {
    qualityScore = scoreSpecAndRelatedPOMFiles(absoluteSpecPath, projectRoot);
    if (input.generateHtmlReport && qualityScore) {
      qualityReportHtmlPath = generateQualityHtmlReport({
        score: qualityScore,
        projectRoot,
        specPath: input.specPath,
        suiteStatus: status === "runner_error" || status === "interrupted" || status === "flaky" ? "failed" : status,
        durationMs,
        totalTests: summary.total,
        passedTests: summary.passed,
        failedTests: summary.failed,
        videoPath: videoAttachment?.path,
        traceZipPath: traceAttachment?.path,
      });
    }
  } catch {
    // Ignore scoring / reporting errors to avoid failing the test run tool call
  }

  const budget = OUTPUT_BUDGET[level];
  const shapedTests = shapeTests(flatTests, level);
  const runnerError = classification.runnerError
    ? { ...classification.runnerError, message: boundRunnerText(classification.runnerError.message, level, "message") }
    : undefined;

  const relative = (filePath: string | undefined) => relativeToRoot(projectRoot, filePath);
  const output: RunPlaywrightTestOutput = {
    status,
    detail: level,
    projectRoot,
    durationMs,
    summary,
    ...(runnerError ? { runnerError } : {}),
    ...(failures.length > 0
      ? { failures: failures.slice(0, budget.failures).map((failure) => relativizeFailure(projectRoot, shapeFailure(failure, level))) }
      : {}),
    ...(failures.length > budget.failures ? { failuresOmitted: failures.length - budget.failures } : {}),
    tests: shapedTests.tests,
    ...(shapedTests.omitted > 0 ? { testsOmitted: shapedTests.omitted } : {}),
    runner: {
      exitCode: runner.exitCode,
      signal: runner.signal,
      timedOut: runner.timedOut,
      cancelled: runner.cancelled,
      durationMs: runner.durationMs,
      timeoutMs: runner.timeoutMs,
      reporterStrategy: runConfig.strategy,
      ...(preservedReporters.length > 0 ? { preservedReporters } : {}),
      ...(runConfig.fallbackReason ? { reporterFallbackReason: runConfig.fallbackReason } : {}),
      ...(runner.spawnError ? { spawnError: runner.spawnError } : {}),
      stdoutTruncated: runner.stdoutTruncated,
      stderrTruncated: runner.stderrTruncated,
      ...(level === "summary" && runner.stderr && status !== "passed"
        ? { stderrTail: boundRunnerText(runner.stderr, level, "stderr") }
        : {}),
      ...(level === "full" ? { stdout: runner.stdout, stderr: runner.stderr } : {}),
    },
    reportPath: report ? jsonReportPath : undefined,
    traceZipPath: relative(traceAttachment?.path),
    videoPath: relative(videoAttachment?.path),
    ...(nativeReports
      ? { nativeReports: { htmlReportPath: relative(nativeReports.htmlReportPath), allureResultsPath: relative(nativeReports.allureResultsPath) } }
      : {}),
    qualityScore: qualityScore ? (level === "full" ? qualityScore : compactQualityScore(qualityScore, level)) : undefined,
    qualityReportHtmlPath: relative(qualityReportHtmlPath),
    healingGateDirective: failures.length > 0 ? HEALING_GATE_DIRECTIVE : undefined,
    reportPromptDirective:
      "After summarizing the result, prompt the user if they want to generate and view the visual report (Quality HTML / Playwright HTML / Allure). Do not generate reports automatically unless confirmed.",
  };
  return fitToBudget(output, level);
}
