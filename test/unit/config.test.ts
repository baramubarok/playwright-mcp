import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkPlaywrightConfig } from "../../src/tools/checkPlaywrightConfig.js";

async function withConfig(fileName: string, content: string, run: (root: string) => void | Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "mcp-config-test-"));
  try {
    await writeFile(path.join(root, fileName), content);
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("statically analyzes a defineConfig() config including use and reporters", async () => {
  await withConfig(
    "playwright.config.ts",
    [
      "import { defineConfig } from '@playwright/test';",
      "export default defineConfig({",
      "  retries: process.env.CI ? 2 : 0,",
      "  forbidOnly: !!process.env.CI,",
      "  fullyParallel: true,",
      "  reporter: [['html', { open: 'never' }], ['json', { outputFile: 'r.json' }], ['allure-playwright']],",
      "  use: { trace: 'on-first-retry', screenshot: 'only-on-failure', video: 'retain-on-failure' },",
      "});",
      "",
    ].join("\n"),
    (root) => {
      const result = checkPlaywrightConfig({ projectRoot: root });
      assert.equal(result.found, true);
      assert.equal(result.analysis, "ast");
      assert.equal(result.configPath, "playwright.config.ts");
      assert.equal(result.settings.retries, "process.env.CI ? 2 : 0");
      assert.equal(result.settingDetails?.retries.kind, "expression");
      assert.equal(result.settingDetails?.retries.line, 3);
      assert.equal(result.settings.trace, "'on-first-retry'");
      assert.equal(result.settingDetails?.trace.kind, "literal");
      assert.equal(result.settingDetails?.workers.kind, "missing");
      assert.deepEqual(result.reporters, { detected: ["html", "json", "allure-playwright"], html: true, json: true, allure: true, determinable: true });
      assert.deepEqual(result.warnings, []);
      assert.match(result.note, /never executed/);
    },
  );
});

test("does not mistake comments, strings or top-level trace for use.trace", async () => {
  await withConfig(
    "playwright.config.ts",
    "// retries: 3\nexport default { trace: 'on', reporter: 'list', name: 'retries: 5' };\n",
    (root) => {
      const result = checkPlaywrightConfig({ projectRoot: root });
      assert.equal(result.settingDetails?.retries.kind, "missing");
      assert.equal(result.settingDetails?.trace.kind, "missing", "trace is only valid inside use");
      assert.ok(result.warnings.some((warning) => /No `retries` setting/.test(warning)));
      assert.ok(result.warnings.some((warning) => /`trace` is missing or 'off'/.test(warning)));
      assert.ok(result.warnings.some((warning) => /Configured reporter\(s\) list do not include 'html'/.test(warning)));
    },
  );
});

test("reads CommonJS configs, same-file variables, projects[].use and reports spreads", async () => {
  await withConfig(
    "playwright.config.js",
    [
      "const { defineConfig, devices } = require('@playwright/test');",
      "const base = { retries: 1 };",
      "const config = defineConfig({",
      "  ...base,",
      "  reporter: process.env.CI ? [['github']] : [['html']],",
      "  use: { trace: 'off' },",
      "  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], video: 'on' } }],",
      "});",
      "module.exports = config;",
      "",
    ].join("\n"),
    (root) => {
      const result = checkPlaywrightConfig({ projectRoot: root });
      assert.equal(result.analysis, "ast");
      assert.equal(result.settingDetails?.video.scope, "project");
      assert.equal(result.settings.video, "'on'");
      assert.ok(result.warnings.some((warning) => /`trace` is missing or 'off'/.test(warning)));
      assert.equal(result.reporters?.determinable, false);
      assert.ok(result.limitations?.some((limitation) => /spread syntax/.test(limitation)));
      assert.ok(result.limitations?.some((limitation) => /runtime expressions/.test(limitation)));
    },
  );
});

test("falls back to a labelled text scan when the config object is not statically reachable", async () => {
  await withConfig("playwright.config.ts", "import { make } from './make';\nexport default make({ retries: 2 });\nconst x = { retries: 4 };\n", (root) => {
    const result = checkPlaywrightConfig({ projectRoot: root });
    assert.equal(result.found, true);
    assert.equal(result.analysis, "ast", "call arguments are still analyzed");
    assert.equal(result.settings.retries, "2");
  });
  await withConfig("playwright.config.ts", "import config from './shared';\nexport default config;\n", (root) => {
    const result = checkPlaywrightConfig({ projectRoot: root });
    assert.equal(result.analysis, "text_scan");
    assert.ok(result.limitations?.[0]?.includes("heuristic text scan"));
  });
});

test("returns an actionable warning when no Playwright config can be found", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mcp-config-missing-"));
  try {
    const result = checkPlaywrightConfig({ projectRoot: root });

    assert.equal(result.found, false);
    assert.equal(result.configPath, null);
    assert.match(result.warnings[0], /No playwright\.config\.\* found/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
