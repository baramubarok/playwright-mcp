export type ErrorType = "locator_not_found" | "timeout" | "assertion_failed" | "network" | "unknown";

export function categorizeError(message: string | undefined): ErrorType {
  if (!message) return "unknown";
  if (/timeout/i.test(message)) return "timeout";
  if (/strict mode violation|resolved to \d+ element|locator\(|getBy[A-Z]/i.test(message)) return "locator_not_found";
  if (/expect\(|toEqual|toHaveText|toBeVisible|toBeHidden|toBeEnabled|toBeDisabled|Expected.*Received/i.test(message)) return "assertion_failed";
  if (/net::|ECONNREFUSED|ECONNRESET|fetch failed|40\d|50\d/i.test(message)) return "network";
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

export interface PwJsonError {
  message?: string;
  stack?: string;
  value?: string;
  snippet?: string;
  location?: { file?: string; line?: number; column?: number };
}

export interface PwJsonResult {
  status: "passed" | "failed" | "timedOut" | "interrupted" | "skipped";
  duration: number;
  retry: number;
  error?: PwJsonError;
  errors?: PwJsonError[];
  steps?: PwJsonStep[];
  stdout?: PwJsonStdOutput[];
  stderr?: PwJsonStdOutput[];
  attachments?: PwJsonAttachment[];
}

export interface PwJsonTest {
  status: "expected" | "unexpected" | "flaky" | "skipped";
  results: PwJsonResult[];
}

export interface PwJsonSpec {
  title: string;
  ok: boolean;
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
  errors?: Array<{ message?: string }>;
}

export interface TestFailureDetail {
  testTitle: string;
  errorType: ErrorType;
  errorMessage: string;
  location?: {
    file?: string;
    line?: number;
    column?: number;
  };
  screenshotPath?: string;
  traceZipPath?: string;
  recentSteps?: string[];
  consoleErrors?: string[];
  networkErrors?: Array<{ url?: string; status?: number; message?: string }>;
  callLogExcerpt?: string;
}

export interface FlatSpecResult {
  title: string;
  status: "passed" | "failed" | "timedout" | "skipped";
  durationMs: number;
  retries: number;
  errorMessage?: string;
  errorType?: ErrorType;
  location?: {
    file?: string;
    line?: number;
    column?: number;
  };
  attachments: PwJsonAttachment[];
  failureDetail?: TestFailureDetail;
}

function extractCallLog(message: string | undefined): string | undefined {
  if (!message) return undefined;
  const idx = message.indexOf("Call log:");
  return idx >= 0 ? message.slice(idx).trim() : undefined;
}

function extractLocation(
  spec: PwJsonSpec,
  lastError: PwJsonError | undefined
): { file?: string; line?: number; column?: number } | undefined {
  if (lastError?.location?.line) {
    return {
      file: lastError.location.file || spec.file,
      line: lastError.location.line,
      column: lastError.location.column,
    };
  }

  if (lastError?.stack) {
    const match = lastError.stack.match(/at\s+(?:.*?\s+)?\(?(.*?):(\d+):(\d+)\)?/);
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
  const allSteps = flattenSteps(lastResult.steps);
  // Return the last 3 to 5 steps leading to the failure
  return allSteps.slice(-5);
}

function extractConsoleErrors(lastResult: PwJsonResult | undefined): string[] {
  const errors: string[] = [];
  if (lastResult?.stderr) {
    for (const item of lastResult.stderr) {
      const text = item.text || item.buffer;
      if (text) {
        const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
        for (const line of lines) {
          if (/error|uncaught|exception|failed to load/i.test(line)) {
            errors.push(line.trim());
          }
        }
      }
    }
  }
  return errors.slice(0, 10);
}

function extractNetworkErrors(errorMessage?: string, callLog?: string): Array<{ url?: string; status?: number; message?: string }> {
  const networkErrors: Array<{ url?: string; status?: number; message?: string }> = [];
  const textToScan = `${errorMessage ?? ""} ${callLog ?? ""}`;

  // Match HTTP 4xx or 5xx patterns or failed requests
  const httpMatches = textToScan.matchAll(/(https?:\/\/[^\s"']+)\s+(?:returned\s+status|status\s+code)?\s*([45]\d\d)/gi);
  for (const match of httpMatches) {
    networkErrors.push({
      url: match[1],
      status: parseInt(match[2], 10),
      message: `HTTP ${match[2]} error on ${match[1]}`,
    });
  }

  const netFailMatches = textToScan.matchAll(/net::([A-Z_]+)\s+(?:at\s+)?(https?:\/\/[^\s"']+)?/gi);
  for (const match of netFailMatches) {
    networkErrors.push({
      url: match[2],
      message: `Network error: ${match[1]}`,
    });
  }

  return networkErrors;
}

function mapStatus(pwTest: PwJsonTest, lastResult: PwJsonResult | undefined): FlatSpecResult["status"] {
  if (pwTest.status === "skipped") return "skipped";
  if (lastResult?.status === "timedOut") return "timedout";
  if (pwTest.status === "unexpected") return "failed";
  return "passed";
}

export function flattenSuites(suites: PwJsonSuite[], parentFile?: string): FlatSpecResult[] {
  const out: FlatSpecResult[] = [];
  for (const suite of suites) {
    const file = suite.file || parentFile;
    if (suite.specs) {
      for (const spec of suite.specs) {
        if (!spec.file) spec.file = file;
        for (const test of spec.tests) {
          const lastResult = test.results[test.results.length - 1];
          const lastError = lastResult?.error ?? lastResult?.errors?.[0];
          const errorMessage = lastError?.message;
          const status = mapStatus(test, lastResult);
          const errorType = errorMessage ? categorizeError(errorMessage) : undefined;
          const location = extractLocation(spec, lastError);
          const attachments = lastResult?.attachments ?? [];
          const screenshotPath = attachments.find((a) => a.name === "screenshot" || a.path?.endsWith(".png"))?.path;
          const traceZipPath = attachments.find((a) => a.name === "trace" || a.path?.endsWith(".zip"))?.path;
          const callLogExcerpt = extractCallLog(errorMessage);
          const recentSteps = extractRecentSteps(lastResult);
          const consoleErrors = extractConsoleErrors(lastResult);
          const networkErrors = extractNetworkErrors(errorMessage, callLogExcerpt);

          let failureDetail: TestFailureDetail | undefined;
          if (status === "failed" || status === "timedout") {
            failureDetail = {
              testTitle: spec.title,
              errorType: errorType ?? "unknown",
              errorMessage: errorMessage ?? "(no error message captured)",
              location,
              screenshotPath,
              traceZipPath,
              recentSteps: recentSteps.length > 0 ? recentSteps : undefined,
              consoleErrors: consoleErrors.length > 0 ? consoleErrors : undefined,
              networkErrors: networkErrors.length > 0 ? networkErrors : undefined,
              callLogExcerpt,
            };
          }

          out.push({
            title: spec.title,
            status,
            durationMs: test.results.reduce((sum, r) => sum + r.duration, 0),
            retries: Math.max(0, test.results.length - 1),
            errorMessage,
            errorType,
            location,
            attachments,
            failureDetail,
          });
        }
      }
    }
    if (suite.suites) {
      out.push(...flattenSuites(suite.suites, file));
    }
  }
  return out;
}

