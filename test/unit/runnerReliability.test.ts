import assert from "node:assert/strict";
import test from "node:test";
import { classifyRunnerOutcome } from "../../src/lib/runnerClassification.js";
import { runRunnerProcess, validateRunnerTimeout } from "../../src/lib/runnerProcess.js";
import { flattenSuites, type PwJsonReport } from "../../src/lib/playwrightReport.js";

const processResult = (overrides: Partial<Awaited<ReturnType<typeof runRunnerProcess>>> = {}) => ({
  timeoutMs: 120_000,
  exitCode: 0,
  signal: null,
  stdout: "",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  timedOut: false,
  cancelled: false,
  durationMs: 1,
  ...overrides,
});

test("validates timeout defaults and bounds", () => {
  assert.equal(validateRunnerTimeout(undefined), 120_000);
  assert.throws(() => validateRunnerTimeout(99), /between 100 and 900000/);
  assert.throws(() => validateRunnerTimeout(900_001), /between 100 and 900000/);
});

test("captures process outcome and bounded stderr", async () => {
  const result = await runRunnerProcess(process.execPath, ["-e", "process.stdout.write('out'); process.stderr.write('x'.repeat(100)); process.exit(3)"], {
    cwd: process.cwd(),
    timeoutMs: 2_000,
    outputLimitBytes: 20,
  });
  assert.equal(result.exitCode, 3);
  assert.equal(result.stdout, "out");
  assert.equal(result.stderrTruncated, true);
  assert.match(result.stderr, /output truncated/);
  assert.ok(Buffer.byteLength(result.stderr, "utf8") <= 20);
});

test("captures a spawn error instead of throwing or reporting a pass", async () => {
  const result = await runRunnerProcess("/path/that/does/not/exist", [], { cwd: process.cwd(), timeoutMs: 2_000 });
  assert.match(result.spawnError ?? "", /ENOENT/);
  assert.equal(result.exitCode, null);
});

test("terminates a delayed process on timeout and cancellation", async () => {
  const timeoutResult = await runRunnerProcess(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
    cwd: process.cwd(),
    timeoutMs: 100,
  });
  assert.equal(timeoutResult.timedOut, true);
  assert.ok(timeoutResult.durationMs < 2_000);

  const controller = new AbortController();
  const pending = runRunnerProcess(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
    cwd: process.cwd(),
    timeoutMs: 2_000,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 50);
  const cancelledResult = await pending;
  assert.equal(cancelledResult.cancelled, true);
});

test("classifies report and process failures without false passed outcomes", () => {
  const report: PwJsonReport = { suites: [], errors: [{ message: "config failed" }] };
  assert.deepEqual(
    classifyRunnerOutcome({ process: processResult({ exitCode: 1 }), report, reportExists: true, tests: [] }),
    { status: "runner_error", runnerError: { kind: "report_error", message: "config failed" } },
  );
  assert.equal(
    classifyRunnerOutcome({ process: processResult({ exitCode: 0 }), reportExists: false, tests: [] }).status,
    "runner_error",
  );
  assert.equal(
    classifyRunnerOutcome({ process: processResult({ signal: "SIGTERM", exitCode: null }), report: { suites: [] }, reportExists: true, tests: [] }).status,
    "interrupted",
  );
  assert.equal(
    classifyRunnerOutcome({ process: processResult({ signal: "SIGTERM", exitCode: null }), report: { suites: [] }, reportExists: true, tests: [] }).runnerError?.kind,
    "process_failure",
  );
  assert.equal(
    classifyRunnerOutcome({ process: processResult({ signal: "SIGTERM", exitCode: null, timedOut: true }), report: { suites: [] }, reportExists: true, tests: [] }).runnerError?.message,
    "Runner timed out after 120000 milliseconds.",
  );
  assert.equal(
    classifyRunnerOutcome({ process: processResult({ exitCode: null }), report: { suites: [{ title: "suite" }] }, reportExists: true, tests: [flattenSuites([{ title: "suite", specs: [{ title: "passes", ok: true, tests: [{ status: "expected", results: [{ status: "passed", duration: 1, retry: 0 }] }] }] }])[0]] }).runnerError?.kind,
    "process_failure",
  );
  assert.equal(
    classifyRunnerOutcome({ process: processResult({ exitCode: 1 }), report: { suites: [] }, reportExists: true, tests: [] }).runnerError?.kind,
    "empty_suite",
  );
  const tests = flattenSuites([
    { title: "suite", specs: [{ title: "fails", ok: false, tests: [{ status: "unexpected", results: [{ status: "failed", duration: 1, retry: 0 }] }] }] },
  ]);
  assert.equal(classifyRunnerOutcome({ process: processResult({ exitCode: 1 }), report: { suites: [] }, reportExists: true, tests }).status, "failed");
});
