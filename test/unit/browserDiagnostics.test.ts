import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { collectBrowserDiagnostics, DIAGNOSTIC_LIMITS, extractTraceSteps, readTraceDiagnostics } from "../../src/lib/browserDiagnostics.js";
import { enrichFailureDetail } from "../../src/lib/failureDiagnostics.js";
import { flattenSuites } from "../../src/lib/playwrightReport.js";

const traceFixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "traces", "console-network.zip");
const allowAll = { canReadPath: () => true };

test("reads console, page error, network and step events from a real trace.zip", () => {
  const diagnostics = readTraceDiagnostics(traceFixture);
  assert.deepEqual(diagnostics.sources, ["trace"]);
  assert.deepEqual(
    diagnostics.consoleMessages.slice(0, 2),
    [
      { type: "error", text: "order failed", location: "http://shop.test/:1" },
      { type: "warning", text: "slow network", location: "http://shop.test/:1" },
    ],
  );
  assert.deepEqual(diagnostics.pageErrors.map((error) => error.message), ["boom in page"]);
  assert.deepEqual(
    diagnostics.failedRequests.map(({ url, status, failure }) => ({ url, status, failure })),
    [
      { url: "http://shop.test/api/blocked", status: undefined, failure: "net::ERR_CONNECTION_REFUSED" },
      { url: "http://shop.test/api/orders", status: 500, failure: undefined },
    ],
  );
  // Route-handler calls ("Abort request", "Fulfill request") are not steps of the flow and are skipped.
  assert.deepEqual(diagnostics.steps, ['Navigate to "/"', "pay", "Click getByRole('button', { name: 'Pay' })", "Wait for timeout", '[FAILED] Expect "toHaveText"']);
});

test("reads the diagnostics fixture attachment and deduplicates against the trace", () => {
  const body = Buffer.from(
    JSON.stringify({
      consoleMessages: [{ type: "error", text: "order failed", location: "http://shop.test/:1" }, { type: "log", text: "ignored" }],
      pageErrors: [{ message: "fixture-only error" }],
      failedRequests: [{ url: "http://shop.test/api/orders", method: "GET", status: 500, resourceType: "fetch" }],
    }),
  ).toString("base64");
  const diagnostics = collectBrowserDiagnostics(
    [
      { name: "mcp-diagnostics", contentType: "application/json", body },
      { name: "trace", contentType: "application/zip", path: traceFixture },
    ],
    allowAll,
  );
  assert.deepEqual(diagnostics?.sources, ["fixture", "trace"]);
  assert.equal(diagnostics?.consoleMessages.filter((message) => message.text === "order failed").length, 1);
  assert.deepEqual(diagnostics?.pageErrors.map((error) => error.message), ["fixture-only error", "boom in page"]);
  assert.equal(diagnostics?.failedRequests.filter((request) => request.status === 500).length, 1);
});

test("bounds event counts and text length, and never reads unauthorized paths", () => {
  const body = Buffer.from(
    JSON.stringify({ consoleMessages: Array.from({ length: 30 }, (_, index) => ({ type: "error", text: `${index}:${"x".repeat(2_000)}` })) }),
  ).toString("base64");
  const diagnostics = collectBrowserDiagnostics([{ name: "mcp-diagnostics", contentType: "application/json", body }], allowAll);
  assert.equal(diagnostics?.consoleMessages.length, DIAGNOSTIC_LIMITS.consoleMessages);
  assert.equal(diagnostics?.omitted.consoleMessages, 30 - DIAGNOSTIC_LIMITS.consoleMessages);
  assert.ok((diagnostics?.consoleMessages[0].text.length ?? 0) <= DIAGNOSTIC_LIMITS.textLength + 1);

  const denied = collectBrowserDiagnostics([{ name: "trace", contentType: "application/zip", path: traceFixture }], { canReadPath: () => false });
  assert.equal(denied, undefined);
});

test("ignores corrupt archives and attachments instead of failing", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "mcp-diagnostics-"));
  try {
    const notZip = path.join(directory, "trace.zip");
    await writeFile(notZip, "not a zip");
    const diagnostics = collectBrowserDiagnostics(
      [
        { name: "trace", contentType: "application/zip", path: notZip },
        { name: "mcp-diagnostics", contentType: "application/json", body: Buffer.from("{").toString("base64") },
      ],
      allowAll,
    );
    assert.equal(diagnostics, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reconstructs steps up to the first failing call and skips hooks and fixtures", () => {
  const steps = extractTraceSteps([
    { type: "before", callId: "hook@1", method: "hook", title: "Before Hooks" },
    { type: "before", callId: "pw:api@2", parentId: "hook@1", method: "pw:api", title: "Create page" },
    { type: "before", callId: "pw:api@3", method: "pw:api", title: "Navigate to \"/\"" },
    { type: "before", callId: "expect@4", method: "expect", title: "Expect \"toBeVisible\"" },
    { type: "after", callId: "expect@4", error: { message: "failed" } },
    { type: "before", callId: "pw:api@5", method: "pw:api", title: "Close page" },
  ]);
  assert.deepEqual(steps, ['Navigate to "/"', '[FAILED] Expect "toBeVisible"']);
});

test("enriches a failure with browser diagnostics while keeping message-derived network errors", () => {
  const [flat] = flattenSuites([
    {
      title: "a.spec.ts",
      file: "a.spec.ts",
      specs: [
        {
          title: "fails",
          ok: false,
          tests: [
            {
              status: "unexpected",
              results: [
                {
                  status: "failed",
                  duration: 1,
                  retry: 0,
                  error: { message: "Error: page.goto: net::ERR_NAME_NOT_RESOLVED at http://missing.test/" },
                  attachments: [{ name: "trace", contentType: "application/zip", path: traceFixture }],
                },
              ],
            },
          ],
        },
      ],
    },
  ]);
  const detail = enrichFailureDetail(flat.failureDetail!, flat, allowAll);
  assert.deepEqual(detail.diagnosticsSources, ["trace"]);
  assert.ok(detail.consoleErrors?.includes("[error] order failed (http://shop.test/:1)"));
  assert.deepEqual(detail.pageErrors, ["boom in page"]);
  assert.deepEqual(
    detail.networkErrors?.map((error) => error.source),
    ["browser", "browser", "error_message"],
  );
  assert.equal(detail.errorType, "network");
});
