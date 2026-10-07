import assert from "node:assert/strict";
import test from "node:test";
import { readReportFixture } from "../helpers/fixturePaths.js";
import { categorizeError, flattenSuites, type PwJsonReport } from "../../src/lib/playwrightReport.js";

function loadReport(name: string): PwJsonReport {
  return JSON.parse(readReportFixture(name)) as PwJsonReport;
}

test("flattens a passed report and extracts artifacts and steps", () => {
  const [result] = flattenSuites(loadReport("passed.json").suites);

  assert.equal(result.title, "should complete checkout");
  assert.equal(result.status, "passed");
  assert.equal(result.durationMs, 42);
  assert.deepEqual(result.attachments.map((attachment) => attachment.name), ["video", "trace"]);
  assert.equal(result.videoPath, "/tmp/checkout.webm");
  assert.equal(result.failureDetail, undefined);
});

test("extracts failure location, assertion/network category, diagnostics, and recent steps", () => {
  const [result] = flattenSuites(loadReport("failed.json").suites);

  assert.equal(result.status, "failed");
  assert.equal(result.errorType, "assertion_failed");
  assert.deepEqual(result.location, {
    file: "tests/e2e/specs/checkout.spec.ts",
    line: 32,
    column: 11,
  });
  assert.deepEqual(result.failureDetail?.recentSteps, ["Navigate", "Submit order", "[FAILED] [internal] assert error"]);
  // Test-process stderr is not the browser console; browser diagnostics come only from trace/fixture.
  assert.equal(result.failureDetail?.consoleErrors, undefined);
  assert.deepEqual(result.failureDetail?.networkErrors, [
    {
      url: "https://example.test/api/orders",
      status: 500,
      message: "HTTP 500 error on https://example.test/api/orders",
      source: "error_message",
    },
  ]);
  assert.equal(result.failureDetail?.screenshotPath, "/tmp/server-error.png");
});

test("handles nested suites and preserves timeout/interrupted/flaky statuses", () => {
  const report: PwJsonReport = {
    suites: [
      {
        title: "outer",
        file: "outer.spec.ts",
        suites: [{ title: "inner", specs: loadReport("passed.json").suites[0].specs }],
      },
    ],
  };
  const nested = flattenSuites(report.suites);
  assert.equal(nested[0].title, "should complete checkout");
  // The nested spec has no own file; the current parser falls back to the outer suite file.
  assert.equal(nested[0].location?.file, "outer.spec.ts");

  const statuses = flattenSuites(loadReport("statuses.json").suites);
  assert.deepEqual(statuses.map((result) => result.status), ["timedout", "skipped", "flaky", "interrupted"]);
  assert.equal(statuses[2].retries, 1);
  assert.deepEqual(statuses[2].attempts.map((attempt) => attempt.status), ["failed", "passed"]);
});

test("aggregates attachments across retry attempts and creates stable identities", () => {
  const results = flattenSuites([
    {
      title: "duplicate suite",
      file: "duplicate.spec.ts",
      specs: [
        {
          title: "same title",
          ok: false,
          line: 10,
          tests: [
            {
              status: "unexpected",
              results: [
                { status: "failed", duration: 1, retry: 0, attachments: [{ name: "screenshot", path: "/tmp/first.png", contentType: "image/png" }] },
              ],
            },
          ],
        },
        {
          title: "same title",
          ok: false,
          line: 20,
          tests: [
            {
              status: "unexpected",
              results: [
                { status: "failed", duration: 1, retry: 0, attachments: [{ name: "screenshot", path: "/tmp/second.png", contentType: "image/png" }] },
              ],
            },
          ],
        },
      ],
    },
  ]);

  assert.notEqual(results[0].testId, results[1].testId);
  assert.equal(results[0].attachments[0].path, "/tmp/first.png");
  assert.equal(results[1].attachments[0].path, "/tmp/second.png");
});

test("keeps empty and report-level error fixtures distinguishable from malformed JSON", () => {
  assert.deepEqual(flattenSuites(loadReport("empty.json").suites), []);
  assert.deepEqual(loadReport("report-errors.json").errors, [
    { message: "Cannot find module './playwright.config.ts'" },
  ]);
  assert.throws(() => JSON.parse(readReportFixture("malformed.json")), SyntaxError);
});

test("parses a real Playwright 1.62 JSON report: ANSI, ids, projects, error context", () => {
  const [result] = flattenSuites(loadReport("playwright-1.62-failed.json").suites);

  assert.equal(result.testId, "f50ffb23eefd99667046-5401c63f1c7c191eb35b:chromium");
  assert.equal(result.projectName, "chromium");
  assert.equal(result.fullTitle, "checkout > shows order confirmation");
  assert.equal(result.status, "failed");
  assert.equal(result.errorType, "locator_not_found");
  assert.doesNotMatch(result.errorMessage ?? "", /\u001b/);
  assert.match(result.errorMessage ?? "", /^Error: expect\(locator\)\.toHaveText\(expected\) failed/);
  assert.equal(result.location?.file, "/project/tests/fixture.spec.ts");
  assert.ok(result.location?.line);
  assert.equal(result.failureDetail?.errorContextPath, "/project/test-results/fixture-checkout-shows-order-confirmation-chromium/error-context.md");
  assert.equal(result.failureDetail?.traceZipPath, "/project/test-results/fixture-checkout-shows-order-confirmation-chromium/trace.zip");
  assert.deepEqual(result.failedAttemptAttachments.map((attachment) => attachment.name), ["error-context", "trace"]);
});

test("gives the same spec in different projects distinct test ids", () => {
  const spec = { title: "same", ok: false, id: "spec-1", tests: [
    { status: "unexpected" as const, projectId: "chromium", projectName: "chromium", results: [{ status: "failed" as const, duration: 1, retry: 0 }] },
    { status: "unexpected" as const, projectId: "firefox", projectName: "firefox", results: [{ status: "failed" as const, duration: 1, retry: 0 }] },
  ] };
  const results = flattenSuites([{ title: "a.spec.ts", file: "a.spec.ts", specs: [spec] }]);
  assert.deepEqual(results.map((result) => result.testId), ["spec-1:chromium", "spec-1:firefox"]);
  assert.deepEqual(results.map((result) => result.projectName), ["chromium", "firefox"]);
  assert.deepEqual(results.map((result) => result.fullTitle), ["same", "same"], "the file-level suite is not part of the title");
});

test("categorizes real Playwright error messages by the most specific signal", () => {
  const cases: Array<[string, string]> = [
    ["Error: expect(locator).toHaveText(expected) failed\n\nExpected: \"Hello\"\nReceived: \"Hi\"\nTimeout: 500ms", "assertion_failed"],
    ["Error: \u001b[2mexpect(\u001b[22mlocator).toBeVisible() failed\nTimeout: 5000ms\nError: element(s) not found", "locator_not_found"],
    ["TimeoutError: locator.click: Timeout 500ms exceeded.\nCall log:\n  - waiting for getByRole('button', { name: 'Missing' })", "locator_not_found"],
    ["Error: strict mode violation: getByRole('button') resolved to 2 elements", "locator_not_found"],
    ["Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/", "network"],
    ["Test timeout of 30000ms exceeded.", "timeout"],
    ["TimeoutError: locator.click: Timeout 500ms exceeded.\nCall log:\n  - waiting for locator('#a')\n  - locator resolved to <button disabled>", "timeout"],
    ["Error: request failed with status code 503", "network"],
    ["Error: something odd at line 4051", "unknown"],
  ];
  for (const [message, expected] of cases) assert.equal(categorizeError(message), expected, message);
});
