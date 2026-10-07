import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runPlaywrightTest } from "../../src/tools/runPlaywrightTest.js";
import { getFailureDetails } from "../../src/tools/getFailureDetails.js";
import { MAX_RETAINED_RUN_REPORTS, managedRunReportCount } from "../../src/lib/reportRegistry.js";
import { OUTPUT_BUDGET } from "../../src/lib/runOutput.js";

type RunnerCase = {
  mode: string;
  expectedStatus: "passed" | "failed" | "runner_error" | "flaky";
  expectedKind?: string;
};

const fakeCli = `
const fs = require("node:fs");
const path = require("node:path");
const specPath = path.resolve(process.cwd(), process.argv[3]);
const mode = fs.readFileSync(specPath, "utf8").trim();
const configIndex = process.argv.indexOf("--config");
const wrapperPath = configIndex > 0 ? process.argv[configIndex + 1] : undefined;
// Wrapper mode passes the output file through the generated config; CLI-override mode through the env var.
const outputPath = wrapperPath ? process.env.PW_MCP_JSON_OUTPUT : process.env.PLAYWRIGHT_JSON_OUTPUT_NAME;
const config = wrapperPath
  ? { configFile: wrapperPath, wrapperExisted: fs.existsSync(wrapperPath), wrapperSource: fs.readFileSync(wrapperPath, "utf8"), reporter: [["html", { outputFolder: "html-out" }], ["json", { outputFile: outputPath }]] }
  : { reporter: [["json", null]] };
const testResult = (status, retry, error, attachments = []) => ({ status, duration: 3, retry, ...(error ? { error: { message: error } } : {}), attachments });
const reports = {
  passed: { suites: [{ title: "Fake suite", file: "fake.spec.ts", specs: [{ title: "fake passed", ok: true, line: 1, tests: [{ status: "expected", results: [testResult("passed", 0)] }] }] }] },
  failed: { suites: [{ title: "Fake suite", file: "fake.spec.ts", specs: [{ title: "fake failed", ok: false, line: 1, tests: [{ status: "unexpected", results: [testResult("failed", 0, "expect(locator).toBeVisible: Expected true, Received false", [{ name: "screenshot", path: "/tmp/fake-failure.png", contentType: "image/png" }])] }] }] }] },
  flaky: { suites: [{ title: "Fake suite", file: "fake.spec.ts", specs: [{ title: "fake flaky", ok: true, line: 1, tests: [{ status: "flaky", results: [testResult("failed", 0, "first attempt failed", [{ name: "screenshot", path: "/tmp/retry.png", contentType: "image/png" }]), testResult("passed", 1, undefined, [{ name: "trace", path: "/tmp/retry.zip", contentType: "application/zip" }])] }] }] }] },
  empty: { suites: [] },
  reportError: { suites: [], errors: [{ message: "fake report configuration error" }] },
  large: { suites: [{ title: "Large suite", file: "fake.spec.ts", specs: Array.from({ length: 300 }, (_, index) => ({ title: "case " + index, ok: index % 3 !== 0, id: "spec-" + index, line: index + 1, tests: [{ status: index % 3 === 0 ? "unexpected" : "expected", projectId: "chromium", projectName: "chromium", results: [testResult(index % 3 === 0 ? "failed" : "passed", 0, index % 3 === 0 ? "expect(locator).toHaveText(expected) failed\\n" + "Call log:\\n" + "  - waiting\\n".repeat(400) : undefined)] }] })) }] },
};
if (mode === "timeout" || mode === "cancel") {
  setTimeout(() => {}, 10000);
} else if (mode !== "missing") {
  if (mode === "html") fs.mkdirSync("html-out", { recursive: true }), fs.writeFileSync("html-out/index.html", "<html></html>");
  const report = reports[mode === "html" ? "passed" : mode];
  fs.writeFileSync(outputPath, mode === "malformed" ? "{" : JSON.stringify(report ? { config, ...report } : undefined));
  process.exit(mode === "passed" || mode === "flaky" || mode === "html" ? 0 : 1);
}
`;

async function makeFakePlaywrightProject(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "mcp-runner-e2e-"));
  const packageRoot = path.join(root, "node_modules", "@playwright", "test");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fake-playwright-project", devDependencies: { "@playwright/test": "0.0.0" } }));
  await writeFile(path.join(root, "playwright.config.js"), "module.exports = {};\n");
  await writeFile(path.join(root, "fake.spec.ts"), "passed\n");
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
    name: "@playwright/test",
    version: "0.0.0",
    main: "index.js",
    bin: { playwright: "cli.js" },
  }));
  await writeFile(path.join(packageRoot, "index.js"), "module.exports = {};\n");
  await writeFile(path.join(packageRoot, "cli.js"), fakeCli);
  await chmod(path.join(packageRoot, "cli.js"), 0o755);
  return root;
}

async function runCase(root: string, runnerCase: RunnerCase) {
  await writeFile(path.join(root, "fake.spec.ts"), `${runnerCase.mode}\n`);
  return runPlaywrightTest({ specPath: "fake.spec.ts", projectRoot: root, timeoutMs: runnerCase.mode === "timeout" ? 100 : 2_000 });
}

async function withFakeProject(run: (root: string) => Promise<void>): Promise<void> {
  const previousBrowsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  const browserCache = await mkdtemp(path.join(tmpdir(), "mcp-fake-browsers-"));
  await mkdir(path.join(browserCache, "chromium-999"));
  await writeFile(path.join(browserCache, "chromium-999", "INSTALLATION_COMPLETE"), "");
  process.env.PLAYWRIGHT_BROWSERS_PATH = browserCache;
  const root = await makeFakePlaywrightProject();
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(browserCache, { recursive: true, force: true });
    if (previousBrowsersPath === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    else process.env.PLAYWRIGHT_BROWSERS_PATH = previousBrowsersPath;
  }
}

test("runs a local fake Playwright CLI and preserves runner/report outcomes end to end", async () => {
  const previousBrowsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  const browserCache = await mkdtemp(path.join(tmpdir(), "mcp-fake-browsers-"));
  await mkdir(path.join(browserCache, "chromium-999"));
  await writeFile(path.join(browserCache, "chromium-999", "INSTALLATION_COMPLETE"), "");
  process.env.PLAYWRIGHT_BROWSERS_PATH = browserCache;
  const root = await makeFakePlaywrightProject();
  try {
    const cases: RunnerCase[] = [
      { mode: "passed", expectedStatus: "passed" },
      { mode: "failed", expectedStatus: "failed", expectedKind: "process_failure" },
      { mode: "flaky", expectedStatus: "flaky" },
      { mode: "reportError", expectedStatus: "runner_error", expectedKind: "report_error" },
      { mode: "empty", expectedStatus: "runner_error", expectedKind: "empty_suite" },
      { mode: "malformed", expectedStatus: "runner_error", expectedKind: "report_malformed" },
      { mode: "missing", expectedStatus: "runner_error", expectedKind: "report_missing" },
      { mode: "timeout", expectedStatus: "timedout", expectedKind: "timeout" },
    ];

    for (const runnerCase of cases) {
      const result = await runCase(root, runnerCase);
      assert.equal(result.status, runnerCase.mode === "timeout" ? "timedout" : runnerCase.expectedStatus, runnerCase.mode);
      if (runnerCase.expectedKind) assert.equal(result.runnerError?.kind, runnerCase.expectedKind, runnerCase.mode);
      if (runnerCase.mode === "timeout") {
        assert.equal(result.runner?.timedOut, true);
      }
      if (runnerCase.mode === "flaky") {
        assert.equal(result.tests[0]?.retries, 1);
        const full = await runPlaywrightTest({ specPath: "fake.spec.ts", projectRoot: root, timeoutMs: 2_000, detail: "full" });
        assert.deepEqual(full.tests[0]?.attempts?.map((attempt) => attempt.status), ["failed", "passed"]);
        assert.deepEqual(full.tests[0]?.attempts?.flatMap((attempt) => attempt.attachments).map((attachment) => attachment.name), ["screenshot", "trace"]);
        // The flaky test's failing attempt is the diagnostic source, not the final passing attempt.
        assert.equal(full.failures?.[0]?.screenshotPath, "/tmp/retry.png");
      }
      if (runnerCase.mode === "passed") {
        assert.equal(result.runner?.reporterStrategy, "config_wrapper");
        assert.deepEqual(result.runner?.preservedReporters, ["html"]);
        assert.deepEqual(result.tests, [], "summary mode lists only tests that need attention");
      }
      if (runnerCase.mode === "failed") {
        assert.equal(result.runner?.exitCode, 1);
        assert.equal(result.failures?.[0]?.testId, result.tests[0]?.testId);
        assert.ok(result.reportPath);
        const detail = getFailureDetails({ reportPath: result.reportPath!, projectRoot: root, testTitle: "fake failed", testId: result.tests[0]!.testId });
        assert.equal(detail.errorMessage, "expect(locator).toBeVisible: Expected true, Received false");
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(browserCache, { recursive: true, force: true });
    if (previousBrowsersPath === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    else process.env.PLAYWRIGHT_BROWSERS_PATH = previousBrowsersPath;
  }
});

test("writes a temporary wrapper config next to the project config and always removes it", async () => {
  await withFakeProject(async (root) => {
    await writeFile(path.join(root, "fake.spec.ts"), "html\n");
    const result = await runPlaywrightTest({ specPath: "fake.spec.ts", projectRoot: root, timeoutMs: 2_000 });
    assert.equal(result.status, "passed");
    const report = JSON.parse(await readFile(result.reportPath!, "utf8")) as { config: { configFile: string; wrapperExisted: boolean; wrapperSource: string } };
    assert.equal(path.dirname(report.config.configFile), root);
    assert.equal(report.config.wrapperExisted, true);
    assert.match(report.config.wrapperSource, /import userConfigModule from "\.\/playwright\.config\.js"/);
    assert.equal(existsSync(report.config.configFile), false, "wrapper is deleted after the run");
    assert.deepEqual((await readdir(root)).filter((name) => name.startsWith(".pw-mcp-")), []);
    assert.equal(result.nativeReports?.htmlReportPath, path.join("html-out", "index.html"));
  });
});

test("falls back to --reporter=json when the project has no Playwright config", async () => {
  await withFakeProject(async (root) => {
    await rm(path.join(root, "playwright.config.js"));
    await writeFile(path.join(root, "fake.spec.ts"), "passed\n");
    const result = await runPlaywrightTest({ specPath: "fake.spec.ts", projectRoot: root, timeoutMs: 2_000 });
    assert.equal(result.status, "passed", JSON.stringify(result.runnerError));
    assert.equal(result.runner?.reporterStrategy, "cli_override");
  });
});

test("cancels the runner through an AbortSignal (MCP request cancellation)", async () => {
  await withFakeProject(async (root) => {
    await writeFile(path.join(root, "fake.spec.ts"), "cancel\n");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const startedAt = Date.now();
    const result = await runPlaywrightTest({ specPath: "fake.spec.ts", projectRoot: root, timeoutMs: 10_000 }, { signal: controller.signal });
    assert.equal(result.status, "interrupted");
    assert.equal(result.runnerError?.kind, "cancelled");
    assert.ok(Date.now() - startedAt < 5_000);
    assert.deepEqual((await readdir(root)).filter((name) => name.startsWith(".pw-mcp-")), []);
  });
});

test("keeps the default summary within the documented budget on a large failing suite", async () => {
  await withFakeProject(async (root) => {
    await writeFile(path.join(root, "fake.spec.ts"), "large\n");
    const summary = await runPlaywrightTest({ specPath: "fake.spec.ts", projectRoot: root, timeoutMs: 5_000 });
    const size = JSON.stringify(summary).length;
    assert.equal(summary.summary.total, 300);
    assert.equal(summary.summary.failed, 100);
    assert.ok(size <= OUTPUT_BUDGET.summary.maxChars, `summary payload is ${size} chars`);
    assert.ok((summary.failures?.length ?? 0) <= OUTPUT_BUDGET.summary.failures);
    assert.ok((summary.failuresOmitted ?? 0) >= 95);
    assert.ok((summary.testsOmitted ?? 0) >= 80);
    assert.equal(summary.runner?.stdout, undefined, "raw stdout is only returned with detail: full");

    const full = await runPlaywrightTest({ specPath: "fake.spec.ts", projectRoot: root, timeoutMs: 5_000, detail: "full" });
    assert.ok(JSON.stringify(full).length <= OUTPUT_BUDGET.full.maxChars);
    assert.ok(full.tests.length > summary.tests.length);

    // get_failure_details still returns the bounded full detail for an omitted failure.
    const lastFailure = full.tests.filter((test) => test.status === "failed").at(-1)!;
    const detail = getFailureDetails({ reportPath: full.reportPath!, testTitle: lastFailure.title, testId: lastFailure.testId });
    assert.ok(detail.errorMessage.length <= OUTPUT_BUDGET.full.errorMessageChars + 100);
  });
});

test("retains only a bounded number of runner report directories", async () => {
  await withFakeProject(async (root) => {
    await writeFile(path.join(root, "fake.spec.ts"), "passed\n");
    const reportPaths: string[] = [];
    for (let index = 0; index < MAX_RETAINED_RUN_REPORTS + 3; index++) {
      const result = await runPlaywrightTest({ specPath: "fake.spec.ts", projectRoot: root, timeoutMs: 2_000 });
      reportPaths.push(result.reportPath!);
    }
    assert.ok(managedRunReportCount() <= MAX_RETAINED_RUN_REPORTS);
    assert.equal(existsSync(reportPaths[0]), false, "the oldest report directory is removed");
    assert.equal(existsSync(reportPaths.at(-1)!), true);
    assert.throws(
      () => getFailureDetails({ reportPath: reportPaths[0], testTitle: "fake passed" }),
      /outside the allowed project\/report boundaries/,
    );
  });
});

test("kills a detached process group during timeout escalation", async () => {
  const markerDirectory = await mkdtemp(path.join(tmpdir(), "mcp-process-tree-"));
  const marker = path.join(markerDirectory, "descendant-alive");
  const script = [
    "const { spawn } = require('node:child_process');",
    `const marker = ${JSON.stringify(marker)};`,
    "spawn(process.execPath, ['-e', `process.on('SIGTERM', () => {}); setInterval(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), 20)`], { stdio: 'ignore' });",
    "setTimeout(() => {}, 10000);",
  ].join("\n");
  try {
    const { runRunnerProcess } = await import("../../src/lib/runnerProcess.js");
    const result = await runRunnerProcess(process.execPath, ["-e", script], { cwd: process.cwd(), timeoutMs: 100 });
    assert.equal(result.timedOut, true);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const firstRead = await readFile(marker, "utf8").catch(() => "");
    assert.equal(firstRead, "alive");
    await new Promise((resolve) => setTimeout(resolve, 450));
    const secondRead = await readFile(marker, "utf8").catch(() => "");
    assert.equal(secondRead, firstRead);
  } finally {
    await rm(markerDirectory, { recursive: true, force: true });
  }
});
