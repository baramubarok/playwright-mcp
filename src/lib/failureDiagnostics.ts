import { collectBrowserDiagnostics, type CollectDiagnosticsOptions } from "./browserDiagnostics.js";
import type { FlatSpecResult, NetworkErrorDetail, TestFailureDetail } from "./playwrightReport.js";

/**
 * Merge real browser diagnostics (diagnostics fixture attachment and/or trace.zip of the failing
 * attempt) into a failure detail. Message-derived network errors are kept and tagged as such.
 */
export function enrichFailureDetail(
  detail: TestFailureDetail,
  test: FlatSpecResult,
  options: CollectDiagnosticsOptions,
): TestFailureDetail {
  const attachments = test.failedAttemptAttachments.length > 0 ? test.failedAttemptAttachments : test.attachments;
  const diagnostics = collectBrowserDiagnostics(attachments, options);
  if (!diagnostics) return detail;

  const browserNetworkErrors: NetworkErrorDetail[] = diagnostics.failedRequests.map((request) => ({
    url: request.url,
    ...(request.method ? { method: request.method } : {}),
    ...(request.status !== undefined ? { status: request.status } : {}),
    message: request.failure ?? `HTTP ${request.status ?? "error"}${request.resourceType ? ` (${request.resourceType})` : ""}`,
    source: "browser" as const,
  }));
  const networkErrors = [...browserNetworkErrors, ...(detail.networkErrors ?? [])];
  const consoleErrors = diagnostics.consoleMessages.map(
    (message) => `[${message.type}] ${message.text}${message.location ? ` (${message.location})` : ""}`,
  );
  const pageErrors = diagnostics.pageErrors.map((error) => error.message);
  const omitted = diagnostics.omitted;

  return {
    ...detail,
    // Trace steps include every Playwright call; JSON report steps only cover test.step blocks.
    recentSteps: diagnostics.steps.length > 0 ? diagnostics.steps : detail.recentSteps,
    consoleErrors: consoleErrors.length > 0 ? consoleErrors : undefined,
    pageErrors: pageErrors.length > 0 ? pageErrors : undefined,
    networkErrors: networkErrors.length > 0 ? networkErrors : undefined,
    diagnosticsSources: diagnostics.sources,
    ...(omitted.consoleMessages + omitted.pageErrors + omitted.failedRequests > 0 ? { diagnosticsOmitted: omitted } : {}),
  };
}
