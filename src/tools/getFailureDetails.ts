import { readFileSync, existsSync } from "node:fs";
import { z } from "zod";
import { flattenSuites, type PwJsonReport, type TestFailureDetail } from "../lib/playwrightReport.js";

export const getFailureDetailsInputShape = {
  reportPath: z
    .string()
    .describe("The `reportPath` returned by a previous run_playwright_test call for this run."),
  testTitle: z.string().describe("Exact title of the failing test, as returned by run_playwright_test."),
};

export const getFailureDetailsSchema = z.object(getFailureDetailsInputShape);
export type GetFailureDetailsInput = z.infer<typeof getFailureDetailsSchema>;

export type GetFailureDetailsOutput = TestFailureDetail;

export function getFailureDetails(input: GetFailureDetailsInput): GetFailureDetailsOutput {
  if (!existsSync(input.reportPath)) {
    throw new Error(`Report not found at ${input.reportPath} — pass the reportPath from run_playwright_test.`);
  }
  const report: PwJsonReport = JSON.parse(readFileSync(input.reportPath, "utf-8"));
  const flatTests = flattenSuites(report.suites ?? []);
  const match = flatTests.find((t) => t.title === input.testTitle);
  if (!match) {
    throw new Error(`No test titled "${input.testTitle}" found in report ${input.reportPath}.`);
  }
  if (match.status === "passed" || match.status === "skipped") {
    throw new Error(`Test "${input.testTitle}" did not fail (status: ${match.status}) — nothing to diagnose.`);
  }

  if (match.failureDetail) {
    return match.failureDetail;
  }

  return {
    testTitle: match.title,
    errorMessage: match.errorMessage ?? "(no error message captured)",
    errorType: match.errorType ?? "unknown",
    location: match.location,
    screenshotPath: match.attachments.find((a) => a.name === "screenshot" || a.path?.endsWith(".png"))?.path,
    traceZipPath: match.attachments.find((a) => a.name === "trace" || a.path?.endsWith(".zip"))?.path,
  };
}

