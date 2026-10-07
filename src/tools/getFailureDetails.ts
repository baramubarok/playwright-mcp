import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { flattenSuites, HEALING_GATE_DIRECTIVE, type PwJsonReport, type TestFailureDetail } from "../lib/playwrightReport.js";
import { findProjectRoot, resolveInProjectRoot } from "../lib/config.js";
import { isRegisteredReportPath } from "../lib/reportRegistry.js";
import { validatePathWithinRoot } from "../lib/pathSecurity.js";
import { enrichFailureDetail } from "../lib/failureDiagnostics.js";
import { shapeFailure } from "../lib/runOutput.js";
import { McpToolError } from "../lib/toolErrors.js";
import { MAX_REPORT_BYTES } from "./runPlaywrightTest.js";

export const getFailureDetailsInputShape = {
  reportPath: z
    .string()
    .describe("The `reportPath` returned by a previous run_playwright_test call for this run."),
  testTitle: z.string().describe("Exact title of the failing test, as returned by run_playwright_test."),
  testId: z.string().optional().describe("Stable test identity from the run output; required when titles are duplicated (e.g. one spec in several projects)."),
  projectRoot: z.string().optional().describe("Optional project root used to authorize an in-project report path."),
};

export const getFailureDetailsSchema = z.object(getFailureDetailsInputShape);
export type GetFailureDetailsInput = z.infer<typeof getFailureDetailsSchema>;

export type GetFailureDetailsOutput = TestFailureDetail;

interface AuthorizedReport {
  reportPath: string;
  /** Runner-registered reports are trusted to reference attachments anywhere; others only inside the root. */
  attachmentRoot?: string;
}

function authorizeReport(input: GetFailureDetailsInput): AuthorizedReport {
  if (isRegisteredReportPath(input.reportPath)) return { reportPath: input.reportPath };
  try {
    const root = findProjectRoot(undefined, input.projectRoot);
    const candidate = resolveInProjectRoot(input.reportPath, root, {
      mustExist: true,
      expectedType: "file",
    });
    const reportStorage = path.join(root, "test-results");
    const relativeToReportStorage = path.relative(reportStorage, candidate);
    if (
      relativeToReportStorage === "" ||
      relativeToReportStorage === ".." ||
      relativeToReportStorage.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeToReportStorage)
    ) {
      throw new Error("Report is not in the authorized report storage.");
    }
    return { reportPath: candidate, attachmentRoot: root };
  } catch {
    throw new McpToolError(
      "REPORT_ACCESS_DENIED",
      "Report path is outside the allowed project/report boundaries.",
      { allowed: ["reportPath returned by run_playwright_test in this server session", "<projectRoot>/test-results/**"] },
    );
  }
}

function readAuthorizedReport(reportPath: string): PwJsonReport {
  if (!existsSync(reportPath)) {
    throw new McpToolError("REPORT_NOT_FOUND", "Report not found — pass the reportPath from run_playwright_test.");
  }
  if (statSync(reportPath).size > MAX_REPORT_BYTES) {
    throw new McpToolError("REPORT_TOO_LARGE", `Report exceeds the ${MAX_REPORT_BYTES}-byte limit.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(reportPath, "utf-8"));
  } catch (error) {
    throw new McpToolError("REPORT_MALFORMED", "Report is not valid JSON.", { reason: error instanceof Error ? error.message : String(error) });
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { suites?: unknown }).suites)) {
    throw new McpToolError("REPORT_MALFORMED", "Report must be a Playwright JSON report with a suites array.");
  }
  return parsed as PwJsonReport;
}

export function getFailureDetails(input: GetFailureDetailsInput): GetFailureDetailsOutput {
  const authorized = authorizeReport(input);
  const report = readAuthorizedReport(authorized.reportPath);
  const flatTests = flattenSuites(report.suites ?? []);
  const titleMatches = flatTests.filter((t) => t.title === input.testTitle || t.fullTitle === input.testTitle);
  if (titleMatches.length > 1 && !input.testId) {
    throw new McpToolError(
      "AMBIGUOUS_TEST",
      `Multiple tests titled "${input.testTitle}" found; pass the stable testId returned by run_playwright_test.`,
      { candidates: titleMatches.slice(0, 10).map((t) => ({ testId: t.testId, projectName: t.projectName, status: t.status })) },
    );
  }
  const match = input.testId ? titleMatches.find((t) => t.testId === input.testId) : titleMatches[0];
  if (!match) {
    throw new McpToolError(
      "TEST_NOT_FOUND",
      `No test matching title "${input.testTitle}" and testId "${input.testId ?? "(not provided)"}" found in the authorized report.`,
    );
  }
  if (match.status === "passed" || match.status === "skipped") {
    throw new McpToolError("TEST_NOT_FAILED", `Test "${input.testTitle}" did not fail (status: ${match.status}) — nothing to diagnose.`, {
      status: match.status,
    });
  }

  const canReadPath = (filePath: string): boolean => {
    if (!path.isAbsolute(filePath) || !existsSync(filePath)) return false;
    if (!authorized.attachmentRoot) return true;
    try {
      validatePathWithinRoot(filePath, authorized.attachmentRoot, filePath, { expectedType: "file" });
      return true;
    } catch {
      return false;
    }
  };

  const detail: TestFailureDetail = match.failureDetail ?? {
    testId: match.testId,
    testTitle: match.title,
    fullTitle: match.fullTitle,
    errorMessage: match.errorMessage ?? "(no error message captured)",
    errorType: match.errorType ?? "unknown",
    location: match.location,
  };
  return {
    ...shapeFailure(enrichFailureDetail(detail, match, { canReadPath }), "full"),
    healingGateDirective: HEALING_GATE_DIRECTIVE,
  };
}
