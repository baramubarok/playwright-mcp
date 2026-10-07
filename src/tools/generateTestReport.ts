import { existsSync, readdirSync } from "node:fs";
import { z } from "zod";
import { findProjectRoot } from "../lib/config.js";
import { resolveProjectPath } from "../lib/pathSecurity.js";
import { checkTestPrerequisites } from "../lib/prerequisites.js";
import { runRunnerProcess, type RunnerProcessResult } from "../lib/runnerProcess.js";
import { tailText } from "../lib/text.js";

export const ALLURE_GENERATE_TIMEOUT_MS = 120_000;

export const generateTestReportInputShape = {
  reporter: z
    .enum(["quality", "html", "allure"])
    .default("quality")
    .describe(
      "The report to provide: 'quality' (locate test-results/quality-report.html), 'html' (locate the Playwright HTML report written by the project's html reporter), or 'allure' (generate allure-report/ from allure-results/ with the local Allure CLI).",
    ),
  projectRoot: z
    .string()
    .optional()
    .describe("Optional path to target project root. Auto-detected if omitted."),
};

export const generateTestReportSchema = z.object(generateTestReportInputShape);
export type GenerateTestReportInput = z.infer<typeof generateTestReportSchema>;

/**
 * - located: an existing report was found (quality/html are produced by other tools or the runner).
 * - generated: the report was produced by this call (allure).
 * - not_found: nothing to locate; run the tests/tooling first.
 * - setup_required: a prerequisite (Allure CLI, allure-results) is missing.
 * - generation_failed: the generator ran but failed or did not write the expected index.
 */
export type GenerateTestReportStatus = "located" | "generated" | "not_found" | "setup_required" | "generation_failed";

export interface GenerateTestReportOutput {
  reporter: "quality" | "html" | "allure";
  mode: "locate" | "generate";
  status: GenerateTestReportStatus;
  reportPath?: string;
  exists: boolean;
  message: string;
  commandToOpen?: string;
  generator?: {
    command: string;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
    durationMs: number;
    stderrTail?: string;
  };
}

export interface GenerateTestReportOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

function runAllureCli(cliPath: string, root: string, options: GenerateTestReportOptions): Promise<RunnerProcessResult> {
  const args = ["generate", "allure-results", "-o", "allure-report", "--clean"];
  // Allure 3 ships a JavaScript CLI; allure-commandline ships a shell launcher for the Java CLI.
  const isNodeScript = /\.(?:c|m)?js$/.test(cliPath);
  return runRunnerProcess(isNodeScript ? process.execPath : cliPath, isNodeScript ? [cliPath, ...args] : args, {
    cwd: root,
    env: process.env,
    timeoutMs: options.timeoutMs ?? ALLURE_GENERATE_TIMEOUT_MS,
    signal: options.signal,
    outputLimitBytes: 16 * 1024,
  });
}

export async function generateTestReport(
  input: GenerateTestReportInput,
  options: GenerateTestReportOptions = {},
): Promise<GenerateTestReportOutput> {
  const root = findProjectRoot(undefined, input.projectRoot);
  const reporter = input.reporter ?? "quality";

  if (reporter === "quality") {
    const qualityReportPath = resolveProjectPath("test-results/quality-report.html", root);
    const exists = existsSync(qualityReportPath);
    return {
      reporter: "quality",
      mode: "locate",
      status: exists ? "located" : "not_found",
      reportPath: exists ? qualityReportPath : undefined,
      exists,
      message: exists
        ? `Visual Quality Report available at: ${qualityReportPath}`
        : `Quality report not found at ${qualityReportPath}. Run run_playwright_test or score_test_quality with generateHtmlReport: true first.`,
      commandToOpen: exists ? `Open in browser: file://${qualityReportPath}` : undefined,
    };
  }

  if (reporter === "html") {
    const htmlReportPath = resolveProjectPath("playwright-report/index.html", root);
    const exists = existsSync(htmlReportPath);
    return {
      reporter: "html",
      mode: "locate",
      status: exists ? "located" : "not_found",
      reportPath: exists ? htmlReportPath : undefined,
      exists,
      message: exists
        ? `Playwright HTML Report available at: ${htmlReportPath}`
        : `Playwright HTML Report not found at ${htmlReportPath}. Add reporter: [['html']] to playwright.config.* and run run_playwright_test — the project's reporters are preserved during MCP runs. A custom outputFolder is reported by run_playwright_test as nativeReports.htmlReportPath.`,
      commandToOpen: exists ? "npx playwright show-report" : undefined,
    };
  }

  const allureResultsDir = resolveProjectPath("allure-results", root);
  const allureReportIndex = resolveProjectPath("allure-report/index.html", root);
  if (!existsSync(allureResultsDir) || readdirSync(allureResultsDir).length === 0) {
    return {
      reporter: "allure",
      mode: "generate",
      status: "setup_required",
      exists: false,
      message:
        `Allure results not found at ${allureResultsDir}. ` +
        `Install allure-playwright (npm i -D allure-playwright), add ['allure-playwright'] to reporter in playwright.config.*, then re-run tests.`,
    };
  }

  const cliPath = checkTestPrerequisites(root).allure.cliPath;
  if (!cliPath) {
    return {
      reporter: "allure",
      mode: "generate",
      status: "setup_required",
      exists: false,
      message: "No local Allure CLI found. Install one manually (npm i -D allure-commandline, or allure for Allure 3) — it is never downloaded automatically.",
    };
  }

  const result = await runAllureCli(cliPath, root, options);
  const generator = {
    command: `${cliPath} generate allure-results -o allure-report --clean`,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    ...(result.stderr ? { stderrTail: tailText(result.stderr, 1_500) } : {}),
  };
  const indexExists = existsSync(allureReportIndex);
  if (result.spawnError || result.timedOut || result.cancelled || result.exitCode !== 0 || !indexExists) {
    const reason = result.spawnError
      ? `could not start (${result.spawnError})`
      : result.timedOut
        ? `timed out after ${result.timeoutMs} ms`
        : result.cancelled
          ? "was cancelled"
          : result.exitCode !== 0
            ? `exited with code ${result.exitCode ?? `signal ${result.signal}`}`
            : "finished but allure-report/index.html was not written";
    return {
      reporter: "allure",
      mode: "generate",
      status: "generation_failed",
      exists: indexExists,
      message: `Allure generation ${reason}. See generator.stderrTail.`,
      generator,
    };
  }
  return {
    reporter: "allure",
    mode: "generate",
    status: "generated",
    reportPath: allureReportIndex,
    exists: true,
    message: `Allure Report generated successfully at: ${allureReportIndex}`,
    commandToOpen: "npx allure open ./allure-report",
    generator,
  };
}
