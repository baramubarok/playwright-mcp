import type { FlatSpecResult, PwJsonReport } from "./playwrightReport.js";
import type { RunnerProcessResult } from "./runnerProcess.js";

export type RunnerErrorKind =
  | "spawn_error"
  | "process_failure"
  | "timeout"
  | "cancelled"
  | "report_error"
  | "report_missing"
  | "report_malformed"
  | "empty_suite";

export interface RunnerError {
  kind: RunnerErrorKind;
  message: string;
}

export type SuiteStatus = "passed" | "failed" | "timedout" | "interrupted" | "flaky" | "skipped" | "runner_error";

export interface ClassificationInput {
  process: RunnerProcessResult;
  report?: PwJsonReport;
  reportReadError?: string;
  reportExists: boolean;
  tests: FlatSpecResult[];
}

export interface ClassificationResult {
  status: SuiteStatus;
  runnerError?: RunnerError;
}

function processMessage(process: RunnerProcessResult): string {
  if (process.spawnError) return process.spawnError;
  if (process.signal) return `Runner terminated by signal ${process.signal}.`;
  return `Runner exited with code ${process.exitCode ?? "unknown"}.`;
}

/** The precedence is intentional: infrastructure errors must never be hidden by test results. */
export function classifyRunnerOutcome(input: ClassificationInput): ClassificationResult {
  const { process, report, reportReadError, reportExists, tests } = input;
  if (process.timedOut) {
    return {
      status: "timedout",
      runnerError: { kind: "timeout", message: `Runner timed out after ${process.timeoutMs} milliseconds.` },
    };
  }
  if (process.cancelled) {
    return { status: "interrupted", runnerError: { kind: "cancelled", message: "Runner execution was cancelled." } };
  }
  if (process.signal) {
    return {
      status: "interrupted",
      runnerError: { kind: "process_failure", message: processMessage(process) },
    };
  }
  if (process.spawnError) return { status: "runner_error", runnerError: { kind: "spawn_error", message: process.spawnError } };
  if (reportReadError) {
    return { status: "runner_error", runnerError: { kind: "report_malformed", message: reportReadError } };
  }
  if (!reportExists || !report) {
    return {
      status: "runner_error",
      runnerError: { kind: "report_missing", message: "Playwright did not produce a JSON report." },
    };
  }
  if (report.errors && report.errors.length > 0) {
    return {
      status: "runner_error",
      runnerError: {
        kind: "report_error",
        message: report.errors.map((error) => error.message ?? "Unknown Playwright report error").join("\n"),
      },
    };
  }
  if (tests.length === 0) {
    return {
      status: "runner_error",
      runnerError: { kind: "empty_suite", message: "Playwright produced an empty test suite." },
    };
  }
  if (process.exitCode === null && !process.signal) {
    return {
      status: "runner_error",
      runnerError: { kind: "process_failure", message: "Runner closed without an exit code or signal." },
    };
  }
  if (process.exitCode !== 0) {
    return {
      status: tests.some((test) => test.status === "failed" || test.status === "timedout") ? "failed" : "runner_error",
      runnerError: {
        kind: "process_failure",
        message: `${processMessage(process)}${process.stderr ? `\n${process.stderr}` : ""}`,
      },
    };
  }
  if (tests.some((test) => test.status === "interrupted")) return { status: "interrupted" };
  if (tests.some((test) => test.status === "timedout")) return { status: "timedout" };
  if (tests.some((test) => test.status === "failed")) return { status: "failed" };
  if (tests.some((test) => test.status === "flaky")) return { status: "flaky" };
  if (tests.every((test) => test.status === "skipped")) return { status: "skipped" };
  return { status: "passed" };
}
