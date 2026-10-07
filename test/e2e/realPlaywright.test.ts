import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runPlaywrightTest } from "../../src/tools/runPlaywrightTest.js";
import { getFailureDetails } from "../../src/tools/getFailureDetails.js";
import { scaffoldTestDomain } from "../../src/tools/scaffoldTestDomain.js";
import { OUTPUT_BUDGET } from "../../src/lib/runOutput.js";

/**
 * Opt-in end-to-end suite against a real Playwright installation and browsers. Point
 * PW_MCP_REAL_PLAYWRIGHT_WORKSPACE at a directory whose package.json declares "workspaces" and whose
 * node_modules contains @playwright/test with matching browsers, e.g.
 *   mkdir lab && cd lab && echo '{"private":true,"workspaces":["*"]}' > package.json
 *   npm i -D @playwright/test && npx playwright install chromium
 * Temporary projects are created inside it so Playwright resolves as a workspace dependency.
 */
const workspace = process.env.PW_MCP_REAL_PLAYWRIGHT_WORKSPACE;
const skip = workspace ? false : "set PW_MCP_REAL_PLAYWRIGHT_WORKSPACE to run against real Playwright";
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const shopSpec = `
import { test, expect } from '../support/diagnostics.fixture';

test.describe('shop', () => {
  test('shows order confirmation', async ({ page }) => {
    await page.route('http://shop.test/**', async (route) => {
      const url = route.request().url();
      if (url.endsWith('/api/orders')) return route.fulfill({ status: 500, json: { ok: false } });
      return route.fulfill({
        contentType: 'text/html',
        body: '<h1>Shop</h1><script>console.error("order failed"); setTimeout(() => { throw new Error("boom in page") }, 0); fetch("/api/orders");</script>',
      });
    });
    await page.goto('http://shop.test/');
    await page.waitForTimeout(150);
    await test.step('assert confirmation', async () => {
      await expect(page.getByRole('status')).toHaveText('Paid', { timeout: 300 });
    });
  });

  test('passes', async ({ page }) => {
    await page.setContent('<h1>ok</h1>');
    await expect(page.getByRole('heading')).toHaveText('ok');
  });
});
`;

async function makeProject(config: string): Promise<string> {
  const root = await mkdtemp(path.join(workspace!, "mcp-real-"));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: path.basename(root), private: true }));
  await writeFile(path.join(root, "playwright.config.ts"), config);
  return root;
}

test("scaffolded skeleton compiles under strict TypeScript and runs as skipped, not passed", { skip }, async () => {
  const root = await makeProject("import { defineConfig } from '@playwright/test';\nexport default defineConfig({ testDir: './tests' });\n");
  try {
    const scaffold = scaffoldTestDomain({ featureName: "checkoutFlow", steps: ["cart", "payment-info"], projectRoot: root });
    await writeFile(
      path.join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", skipLibCheck: true }, include: ["tests"] }),
    );
    const tsc = spawnSync(process.execPath, [path.join(repositoryRoot, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"], { cwd: root, encoding: "utf8" });
    assert.equal(tsc.status, 0, tsc.stdout + tsc.stderr);

    const result = await runPlaywrightTest({ specPath: scaffold.specFile, projectRoot: root, timeoutMs: 120_000 });
    assert.equal(result.status, "skipped");
    assert.equal(result.summary.skipped, 2);
    assert.equal((result.qualityScore as { skeleton?: boolean }).skeleton, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real run keeps the project's HTML reporter and returns real browser diagnostics", { skip }, async () => {
  const root = await makeProject(
    [
      "import { defineConfig } from '@playwright/test';",
      "export default defineConfig({",
      "  testDir: './tests',",
      "  reporter: [['html', { outputFolder: 'html-out' }]],",
      "  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },",
      "  projects: [{ name: 'chromium-a' }, { name: 'chromium-b' }],",
      "});",
      "",
    ].join("\n"),
  );
  try {
    scaffoldTestDomain({ featureName: "shop", projectRoot: root });
    await mkdir(path.join(root, "tests/e2e/specs"), { recursive: true });
    await writeFile(path.join(root, "tests/e2e/specs/shop-diagnostics.spec.ts"), shopSpec);

    const result = await runPlaywrightTest({ specPath: "tests/e2e/specs/shop-diagnostics.spec.ts", projectRoot: root, timeoutMs: 120_000 });
    assert.equal(result.status, "failed");
    assert.deepEqual(result.summary, { total: 4, passed: 2, failed: 2, timedout: 0, interrupted: 0, flaky: 0, skipped: 0 });
    assert.equal(result.runner?.reporterStrategy, "config_wrapper");
    assert.deepEqual(result.runner?.preservedReporters, ["html"]);
    assert.equal(result.projectRoot, root);
    assert.equal(result.nativeReports?.htmlReportPath, path.join("html-out", "index.html"), "artifact paths are relative to projectRoot");
    assert.ok(existsSync(path.join(root, result.nativeReports!.htmlReportPath!)));
    assert.deepEqual(readdirSync(root).filter((name) => name.startsWith(".pw-mcp-")), [], "wrapper config removed");
    assert.ok(JSON.stringify(result).length <= OUTPUT_BUDGET.summary.maxChars);

    const [first, second] = result.failures!;
    assert.notEqual(first.testId, second.testId, "same spec in two projects has distinct ids");
    assert.deepEqual([first.projectName, second.projectName].sort(), ["chromium-a", "chromium-b"]);
    assert.equal(first.errorType, "locator_not_found");
    assert.doesNotMatch(first.errorMessage, /\u001b/);
    assert.deepEqual(first.diagnosticsSources, ["fixture", "trace"]);
    assert.ok(first.consoleErrors?.some((message) => message.includes("order failed")));
    assert.ok(first.pageErrors?.includes("boom in page"));
    assert.ok(first.networkErrors?.some((error) => error.status === 500 && error.source === "browser"));
    assert.ok(first.recentSteps?.at(-1)?.startsWith("[FAILED]"));
    assert.ok(first.errorContextPath && existsSync(path.join(root, first.errorContextPath)));

    assert.throws(
      () => getFailureDetails({ reportPath: result.reportPath!, testTitle: first.testTitle }),
      /Multiple tests titled/,
    );
    const detail = getFailureDetails({ reportPath: result.reportPath!, testTitle: first.testTitle, testId: first.testId });
    assert.equal(detail.projectName, first.projectName);
    assert.ok(detail.errorContextPath && path.isAbsolute(detail.errorContextPath), "get_failure_details keeps absolute paths");
    assert.ok(detail.callLogExcerpt?.includes("waiting for getByRole('status')"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
