import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { findProjectRoot, resolveInProjectRoot } from "../lib/config.js";
import { flattenSuites, type PwJsonReport, type TestFailureDetail } from "../lib/playwrightReport.js";
import { scoreSpecAndRelatedPOMFiles, type ComprehensiveQualityScore } from "../lib/scoreContent.js";

export const runPlaywrightTestInputShape = {
  specPath: z.string().describe("Path to the spec file, relative to project root or absolute, e.g. \"e2e/payment.spec.ts\"."),
  projectRoot: z
    .string()
    .optional()
    .describe("Optional path to the target project root. If omitted, auto-detected by searching for playwright.config.*."),
  grep: z.string().optional().describe("Only run tests whose title matches this pattern (passed to --grep)."),
  headed: z.boolean().optional().describe("Run in headed (visible browser) mode instead of headless."),
};

export const runPlaywrightTestSchema = z.object(runPlaywrightTestInputShape);
export type RunPlaywrightTestInput = z.infer<typeof runPlaywrightTestSchema>;

export interface RunPlaywrightTestOutput {
  status: "passed" | "failed" | "timedout" | "skipped";
  durationMs: number;
  summary: {
    total: number;
    passed: number;
    failed: number;
    timedout: number;
    skipped: number;
  };
  failures?: TestFailureDetail[];
  tests: Array<{
    title: string;
    status: "passed" | "failed" | "timedout" | "skipped";
    durationMs: number;
    retries: number;
    errorMessage?: string;
    errorType?: string;
    location?: {
      file?: string;
      line?: number;
      column?: number;
    };
  }>;
  reportPath?: string;
  traceZipPath?: string;
  qualityScore?: ComprehensiveQualityScore;
}

export async function runPlaywrightTest(input: RunPlaywrightTestInput): Promise<RunPlaywrightTestOutput> {
  const projectRoot = findProjectRoot(input.specPath, input.projectRoot);
  const absoluteSpecPath = resolveInProjectRoot(input.specPath, projectRoot);
  if (!existsSync(absoluteSpecPath)) {
    throw new Error(`Spec file not found: ${input.specPath}`);
  }

  const reportDir = mkdtempSync(path.join(tmpdir(), "pw-mcp-report-"));
  const jsonReportPath = path.join(reportDir, "report.json");

  const relativeSpecToRoot = path.relative(projectRoot, absoluteSpecPath);
  const args = ["playwright", "test", relativeSpecToRoot, "--reporter=json"];
  if (input.grep) args.push("--grep", input.grep);
  if (input.headed) args.push("--headed");

  const startedAt = Date.now();
  await new Promise<void>((resolve) => {
    const child = spawn(process.platform === "win32" ? "npx.cmd" : "npx", args, {
      cwd: projectRoot,
      env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: jsonReportPath },
    });
    // Playwright exits non-zero when tests fail — that's expected, not a tool error.
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
  const durationMs = Date.now() - startedAt;

  if (!existsSync(jsonReportPath)) {
    throw new Error(
      `Playwright did not produce a JSON report — check that Playwright is installed in "${projectRoot}" ` +
        `and that "${input.specPath}" is a valid spec file.`
    );
  }

  const report: PwJsonReport = JSON.parse(readFileSync(jsonReportPath, "utf-8"));
  const flatTests = flattenSuites(report.suites ?? []);

  const total = flatTests.length;
  const passed = flatTests.filter((t) => t.status === "passed").length;
  const failed = flatTests.filter((t) => t.status === "failed").length;
  const timedout = flatTests.filter((t) => t.status === "timedout").length;
  const skipped = flatTests.filter((t) => t.status === "skipped").length;

  const status: RunPlaywrightTestOutput["status"] = failed > 0
    ? "failed"
    : timedout > 0
      ? "timedout"
      : total > 0 && skipped === total
        ? "skipped"
        : "passed";

  const failures: TestFailureDetail[] = flatTests
    .map((t) => t.failureDetail)
    .filter((f): f is TestFailureDetail => f !== undefined);

  const traceAttachment = flatTests.flatMap((t) => t.attachments).find((a) => a.name === "trace" || a.path?.endsWith(".zip"));

  let qualityScore: ComprehensiveQualityScore | undefined;
  try {
    if (existsSync(absoluteSpecPath)) {
      qualityScore = scoreSpecAndRelatedPOMFiles(absoluteSpecPath, projectRoot);
    }
  } catch {
    // Ignore scoring errors to avoid failing the test run tool call
  }

  return {
    status,
    durationMs,
    summary: {
      total,
      passed,
      failed,
      timedout,
      skipped,
    },
    failures: failures.length > 0 ? failures : undefined,
    tests: flatTests.map((t) => ({
      title: t.title,
      status: t.status,
      durationMs: t.durationMs,
      retries: t.retries,
      errorMessage: t.errorMessage,
      errorType: t.errorType,
      location: t.location,
    })),
    reportPath: jsonReportPath,
    traceZipPath: traceAttachment?.path,
    qualityScore,
  };
}

