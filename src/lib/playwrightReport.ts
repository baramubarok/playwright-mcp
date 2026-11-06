import { stripAnsi } from "./text.js";

export type ErrorType = "locator_not_found" | "timeout" | "assertion_failed" | "network" | "unknown";

/**
 * Categorize a Playwright error message. Order matters: most Playwright failures mention a
 * timeout, so the more specific signals (network, locator resolution, assertion) are checked first.
 */
export function categorizeError(message: string | undefined): ErrorType {
  if (!message) return "unknown";
  const text = stripAnsi(message);
  if (/net::ERR_[A-Z_]+|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed/i.test(text)) return "network";
  if (/strict mode violation|resolved to \d+ elements|element\(s\) not found/i.test(text)) return "locator_not_found";
  if (/\bexpect(?:\.soft|\.poll)?\(|\bExpected\b[\s\S]*\bReceived\b/.test(text)) return "assertion_failed";
  if (/waiting for (?:locator|getBy\w+|selector|frameLocator)/i.test(text) && !/locator resolved to/i.test(text)) {
    return "locator_not_found";
  }
  if (/timeout|timed out/i.test(text)) return "timeout";
  if (/\b(?:status(?: code)?|HTTP)\s*[:=]?\s*[45]\d\d\b/i.test(text)) return "network";
  return "unknown";
}

export interface PwJsonAttachment {
  name: string;
  path?: string;
  contentType: string;
  body?: string;
}

export interface PwJsonStep {
  title: string;
  duration?: number;
  error?: { message?: string; stack?: string };
  steps?: PwJsonStep[];
}

export interface PwJsonStdOutput {
  text?: string;
  buffer?: string;
}

export interface PwJsonLocation {
  file?: string;
  line?: number;
  column?: number;
}

export interface PwJsonError {
  message?: string;
  stack?: string;
  value?: string;
  snippet?: string;
  location?: PwJsonLocation;
}

export interface PwJsonResult {
  status: "passed" | "failed" | "timedOut" | "interrupted" | "skipped";
  duration: number;
  retry: number;
  workerIndex?: number;
  startTime?: string;
  error?: PwJsonError;
  errors?: PwJsonError[];
  errorLocation?: PwJsonLocation;
  /** Not emitted by Playwright's JSON reporter; kept for custom/legacy reports. */
  steps?: PwJsonStep[];
  stdout?: PwJsonStdOutput[];
  stderr?: PwJsonStdOutput[];
  attachments?: PwJsonAttachment[];
}

export interface PwJsonTest {
  status: "expected" | "unexpected" | "flaky" | "skipped";
  results: PwJsonResult[];
  projectId?: string;
  projectName?: string;
  expectedStatus?: string;
  /** Not emitted by Playwright's JSON reporter; kept for custom/legacy reports. */
  testId?: string;
}

export interface PwJsonSpec {
  title: string;
  ok: boolean;
  id?: string;
  tags?: string[];
  file?: string;
  line?: number;
  column?: number;
  tests: PwJsonTest[];
}

export interface PwJsonSuite {
  title: string;
  file?: string;
  line?: number;
  column?: number;
  suites?: PwJsonSuite[];
  specs?: PwJsonSpec[];
}

export interface PwJsonReport {
  suites: PwJsonSuite[];
  errors?: Array<{ message?: string; stack?: string; location?: PwJsonLocation }>;
  config?: { rootDir?: string; configFile?: string; version?: string };
  stats?: Record<string, unknown>;
}

export interface TestAttempt {
  retry: number;
  status: PwJsonResult["status"];
  durationMs: number;
  errorMessage?: string;
  attachments: PwJsonAttachment[];
}

export interface NetworkErrorDetail {
  url?: string;
  method?: string;
  status?: number;
  message?: string;
  source?: "browser" | "error_message";
}

export interface TestFailureDetail {
  testId?: string;
  testTitle: string;
  fullTitle?: string;
  projectName?: string;
  errorType: ErrorType;
  errorMessage: string;
  location?: PwJsonLocation;
  screenshotPath?: string;
  traceZipPath?: string;
  videoPath?: string;
  /** Markdown ARIA snapshot of the page at failure time, written by Playwright. */
  errorContextPath?: string;
  recentSteps?: string[];
  consoleErrors?: string[];
  pageErrors?: string[];
  networkErrors?: NetworkErrorDetail[];
  /** Where browser diagnostics came from; absent when no trace or diagnostics fixture was available. */
  diagnosticsSources?: Array<"trace" | "fixture">;
  diagnosticsOmitted?: { consoleMessages: number; pageErrors: number; failedRequests: number };
  callLogExcerpt?: string;
  healingGateDirective?: string;
}

export type FlatTestStatus = "passed" | "failed" | "timedout" | "interrupted" | "flaky" | "skipped";

export interface FlatSpecResult {
  testId: string;
  title: string;
  fullTitle: string;
  projectName?: string;
  status: FlatTestStatus;
  durationMs: number;
  retries: number;
  errorMessage?: string;
  errorType?: ErrorType;
  location?: PwJsonLocation;
  attachments: PwJsonAttachment[];
  /** Attachments of the last attempt that did not pass; the source for browser diagnostics. */
  failedAttemptAttachments: PwJsonAttachment[];
  attempts: TestAttempt[];
  failureDetail?: TestFailureDetail;
  videoPath?: string;
}

export const HEALING_GATE_DIRECTIVE =
  "MANDATORY ACTION: Do NOT edit code automatically. Summarize failure in 2-3 lines and request user confirmation with your proposed Page Object fix before modifying any file.";

function clean(value: string | undefined): string | undefined {
  return value === undefined ? undefined : stripAnsi(value);
}

function extractCallLog(message: string | undefined): string | undefined {
  if (!message) return undefined;
  const idx = message.indexOf("Call log:");
  return idx >= 0 ? message.slice(idx).trim() : undefined;
}

function extractLocation(
  spec: PwJsonSpec,
  lastError: PwJsonError | undefined,
  errorLocation: PwJsonLocation | undefined,
): PwJsonLocation | undefined {
  const preferred = lastError?.location?.line ? lastError.location : errorLocation?.line ? errorLocation : undefined;
  if (preferred) {
    return { file: preferred.file || spec.file, line: preferred.line, column: preferred.column };
  }

  if (lastError?.stack) {
    const match = stripAnsi(lastError.stack).match(/at\s+(?:.*?\s+)?\(?(.*?):(\d+):(\d+)\)?/);
    if (match) {
      return {
        file: match[1],
        line: parseInt(match[2], 10),
        column: parseInt(match[3], 10),
      };
    }
  }

  if (spec.line) {
    return {
      file: spec.file,
      line: spec.line,
      column: spec.column,
    };
  }

  return undefined;
}

function flattenSteps(steps: PwJsonStep[]): string[] {
  const result: string[] = [];
  for (const step of steps) {
    const statusPrefix = step.error ? "[FAILED] " : "";
    result.push(`${statusPrefix}${step.title}`);
    if (step.steps && step.steps.length > 0) {
      result.push(...flattenSteps(step.steps));
    }
  }
  return result;
}

function extractRecentSteps(lastResult: PwJsonResult | undefined): string[] {
  if (!lastResult?.steps || lastResult.steps.length === 0) {
    return [];
  }
  return flattenSteps(lastResult.steps).slice(-5);
}

/** Network failures named in the error text itself, e.g. `page.goto: net::ERR_CONNECTION_REFUSED at http://…`. */
function extractNetworkErrorsFromMessage(errorMessage?: string): NetworkErrorDetail[] {
  const networkErrors: NetworkErrorDetail[] = [];
  const textToScan = errorMessage ?? "";

  const httpMatches = textToScan.matchAll(/(https?:\/\/[^\s"']+)\s+(?:returned\s+status\s+|status\s+code\s+)?([45]\d\d)\b/gi);
  for (const match of httpMatches) {
    networkErrors.push({
      url: match[1],
      status: parseInt(match[2], 10),
      message: `HTTP ${match[2]} error on ${match[1]}`,
      source: "error_message",
    });
  }

  const netFailMatches = textToScan.matchAll(/net::([A-Z_]+)(?:\s+at\s+(https?:\/\/[^\s"']+))?/g);
  for (const match of netFailMatches) {
    networkErrors.push({
      ...(match[2] ? { url: match[2] } : {}),
      message: `Network error: net::${match[1]}`,
      source: "error_message",
    });
  }

  return networkErrors.slice(0, 10);
}

function mapStatus(pwTest: PwJsonTest, lastResult: PwJsonResult | undefined): FlatTestStatus {
  if (pwTest.status === "skipped") return "skipped";
  if (lastResult?.status === "interrupted") return "interrupted";
  if (lastResult?.status === "timedOut") return "timedout";
  if (pwTest.status === "flaky") return "flaky";
  if (pwTest.status === "unexpected" || lastResult?.status === "failed") return "failed";
  return "passed";
}

function collectAttachments(results: PwJsonResult[]): PwJsonAttachment[] {
  const seen = new Set<string>();
  const attachments: PwJsonAttachment[] = [];
  for (const attachment of results.flatMap((result) => result.attachments ?? [])) {
    const key = `${attachment.name}\u0000${attachment.path ?? ""}\u0000${attachment.body ?? ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      attachments.push(attachment);
    }
  }
  return attachments;
}

const findAttachment = (attachments: PwJsonAttachment[], name: string, extension: string) =>
  attachments.find((a) => a.name === name || a.path?.endsWith(extension))?.path;

/**
 * Stable identity for a test: Playwright's spec id plus the project id, so the same spec running in
 * several projects (chromium/firefox/…) gets distinct ids. Falls back to a positional id for
 * reports that do not carry Playwright ids.
 */
function stableTestId(spec: PwJsonSpec, test: PwJsonTest, file: string | undefined, suitePath: string, testIndex: number): string {
  if (test.testId) return test.testId;
  if (spec.id) return test.projectId ? `${spec.id}:${test.projectId}` : `${spec.id}:${testIndex}`;
  return `${spec.file ?? file ?? "unknown"}:${suitePath}:${spec.line ?? 0}:${spec.column ?? 0}:${spec.title}:${testIndex}`;
}

export function flattenSuites(suites: PwJsonSuite[], parentFile?: string, parentSuitePath = "", parentTitlePath: string[] = []): FlatSpecResult[] {
  const out: FlatSpecResult[] = [];
  for (const suite of suites) {
    const file = suite.file || parentFile;
    const suitePath = parentSuitePath ? `${parentSuitePath} > ${suite.title}` : suite.title;
    // The top-level suite of a Playwright report is the file itself; it is not part of the test title.
    const isFileSuite = parentTitlePath.length === 0 && suite.file !== undefined && suite.title === suite.file;
    const titlePath = isFileSuite || !suite.title ? parentTitlePath : [...parentTitlePath, suite.title];
    if (suite.specs) {
      for (const spec of suite.specs) {
        if (!spec.file) spec.file = file;
        for (const [testIndex, test] of spec.tests.entries()) {
          const lastResult = test.results[test.results.length - 1];
          const lastError = [...test.results].reverse().map((result) => result.error ?? result.errors?.[0]).find(Boolean);
          const errorMessage = clean(lastError?.message);
          const status = mapStatus(test, lastResult);
          const testId = stableTestId(spec, test, file, suitePath, testIndex);
          const fullTitle = [...titlePath, spec.title].join(" > ");
          const errorType = errorMessage ? categorizeError(errorMessage) : undefined;
          const lastFailedResult = [...test.results].reverse().find((result) => result.status !== "passed" && result.status !== "skipped");
          const location = extractLocation(spec, lastError, lastFailedResult?.errorLocation ?? lastResult?.errorLocation);
          const attachments = collectAttachments(test.results);
          const failedAttemptAttachments = lastFailedResult?.attachments ?? [];
          const diagnosticAttachments = failedAttemptAttachments.length > 0 ? failedAttemptAttachments : attachments;
          const videoPath = findAttachment(attachments, "video", ".webm");
          const callLogExcerpt = extractCallLog(errorMessage);
          const recentSteps = extractRecentSteps(lastFailedResult ?? lastResult);
          const networkErrors = extractNetworkErrorsFromMessage(errorMessage);

          let failureDetail: TestFailureDetail | undefined;
          if (status === "failed" || status === "timedout" || status === "interrupted" || status === "flaky") {
            failureDetail = {
              testId,
              testTitle: spec.title,
              fullTitle,
              ...(test.projectName ? { projectName: test.projectName } : {}),
              errorType: errorType ?? "unknown",
              errorMessage: errorMessage ?? "(no error message captured)",
              location,
              screenshotPath: findAttachment(diagnosticAttachments, "screenshot", ".png"),
              traceZipPath: findAttachment(diagnosticAttachments, "trace", ".zip"),
              videoPath: findAttachment(diagnosticAttachments, "video", ".webm") ?? videoPath,
              errorContextPath: diagnosticAttachments.find((a) => a.name === "error-context")?.path,
              recentSteps: recentSteps.length > 0 ? recentSteps : undefined,
              networkErrors: networkErrors.length > 0 ? networkErrors : undefined,
              callLogExcerpt,
              healingGateDirective: HEALING_GATE_DIRECTIVE,
            };
          }

          out.push({
            testId,
            title: spec.title,
            fullTitle,
            ...(test.projectName ? { projectName: test.projectName } : {}),
            status,
            durationMs: test.results.reduce((sum, r) => sum + r.duration, 0),
            retries: Math.max(0, test.results.length - 1),
            attempts: test.results.map((result) => ({
              retry: result.retry,
              status: result.status,
              durationMs: result.duration,
              errorMessage: clean(result.error?.message ?? result.errors?.[0]?.message),
              attachments: result.attachments ?? [],
            })),
            errorMessage,
            errorType,
            location,
            attachments,
            failedAttemptAttachments,
            failureDetail,
            videoPath,
          });
        }
      }
    }
    if (suite.suites) {
      out.push(...flattenSuites(suite.suites, file, suitePath, titlePath));
    }
  }
  return out;
}
