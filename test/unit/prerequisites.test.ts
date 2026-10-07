import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkTestPrerequisites } from "../../src/lib/prerequisites.js";

async function makeProject(packageJson: string, config?: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "mcp-prerequisites-"));
  await writeFile(path.join(root, "package.json"), packageJson);
  if (config !== undefined) await writeFile(path.join(root, "playwright.config.ts"), config);
  return root;
}

test("reports a new project as setup required without attempting installation", async () => {
  const root = await makeProject("{}\n");
  try {
    const result = checkTestPrerequisites(root);
    assert.equal(result.packageJsonFound, true);
    assert.equal(result.playwright.packageInstalled, false);
    assert.equal(result.playwright.ready, false);
    assert.equal(result.playwright.status, "setup_required");
    assert.match(result.nextSteps.join("\n"), /npm install -D @playwright\/test/);
    assert.ok(["installed", "missing", "unknown"].includes(result.playwright.browsers.status));
    assert.equal(result.allure.status, "not_configured");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detects configured Allure as incomplete when its adapter or CLI is unavailable", async () => {
  const root = await makeProject(
    JSON.stringify({ devDependencies: { "@playwright/test": "^1.0.0", "allure-playwright": "^2.0.0" } }),
    "export default { reporter: [['allure-playwright']] };\n",
  );
  try {
    const result = checkTestPrerequisites(root);
    assert.equal(result.allure.configuredReporter, true);
    assert.equal(result.allure.status, "setup_required");
    assert.ok(result.nextSteps.some((step) => /allure-playwright|allure-commandline/.test(step)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("requires Allure reporter configuration when optional packages are present", async () => {
  const root = await makeProject("{}\n");
  try {
    const result = checkTestPrerequisites(root);
    assert.equal(result.allure.configuredReporter, false);
    assert.equal(result.allure.status, "not_configured");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detects existing Allure results and report paths without generating them", async () => {
  const root = await makeProject("{}\n", "export default {};\n");
  try {
    await mkdir(path.join(root, "allure-results"));
    await mkdir(path.join(root, "allure-report"));
    await writeFile(path.join(root, "allure-report", "index.html"), "<html></html>\n");
    const result = checkTestPrerequisites(root);
    assert.equal(result.allure.resultsAvailable, true);
    assert.equal(result.allure.reportAvailable, true);
    assert.equal(result.allure.status, "not_configured");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
async function writePackage(packageRoot: string, name: string, extra: Record<string, unknown> = {}): Promise<void> {
  await mkdir(packageRoot, { recursive: true });
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name, version: "1.62.1", main: "index.js", ...extra }));
  await writeFile(path.join(packageRoot, "index.js"), "module.exports = {};\n");
}

async function withBrowserCache(entries: Record<string, boolean>, run: () => Promise<void>): Promise<void> {
  const previous = process.env.PLAYWRIGHT_BROWSERS_PATH;
  const cache = await mkdtemp(path.join(tmpdir(), "mcp-browser-cache-"));
  for (const [entry, complete] of Object.entries(entries)) {
    await mkdir(path.join(cache, entry));
    if (complete) await writeFile(path.join(cache, entry, "INSTALLATION_COMPLETE"), "");
  }
  process.env.PLAYWRIGHT_BROWSERS_PATH = cache;
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    else process.env.PLAYWRIGHT_BROWSERS_PATH = previous;
    await rm(cache, { recursive: true, force: true });
  }
}

/** A Playwright install whose playwright-core expects chromium-1234. */
async function installPlaywright(nodeModules: string): Promise<void> {
  await writePackage(path.join(nodeModules, "@playwright", "test"), "@playwright/test", { bin: { playwright: "cli.js" } });
  await writeFile(path.join(nodeModules, "@playwright", "test", "cli.js"), "");
  await writePackage(path.join(nodeModules, "playwright-core"), "playwright-core");
  await writeFile(
    path.join(nodeModules, "playwright-core", "browsers.json"),
    JSON.stringify({ browsers: [{ name: "chromium", revision: "1234", installByDefault: true }, { name: "webkit", revision: "2336", installByDefault: true, revisionOverrides: { mac14: "2251" } }] }),
  );
}

test("accepts Playwright hoisted to a declared workspace root", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "mcp-workspace-"));
  try {
    await writeFile(path.join(workspace, "package.json"), JSON.stringify({ private: true, workspaces: ["apps/*"] }));
    await installPlaywright(path.join(workspace, "node_modules"));
    const project = path.join(workspace, "apps", "web");
    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, "package.json"), JSON.stringify({ devDependencies: { "@playwright/test": "1.62.1" } }));
    await withBrowserCache({ "chromium-1234": true }, async () => {
      const result = checkTestPrerequisites(project);
      assert.equal(result.workspaceRoot, workspace);
      assert.equal(result.playwright.resolvedFrom, "workspace");
      assert.equal(result.playwright.ready, true);
      assert.ok(result.warnings.some((warning) => /workspace root/.test(warning)));
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("rejects a stray Playwright from a parent directory that is not a workspace", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "mcp-stray-parent-"));
  try {
    await installPlaywright(path.join(parent, "node_modules"));
    const project = path.join(parent, "project");
    await mkdir(project);
    await writeFile(path.join(project, "package.json"), "{}\n");
    const result = checkTestPrerequisites(project);
    assert.equal(result.workspaceRoot, undefined);
    assert.equal(result.playwright.packageInstalled, false);
    assert.equal(result.playwright.ready, false);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("detects outdated or incomplete browser builds and branded channels", async () => {
  const root = await makeProject("{}\n", "export default { use: { channel: 'chrome' } };\n");
  try {
    await installPlaywright(path.join(root, "node_modules"));
    await withBrowserCache({ "chromium-1100": true, "chromium-1234": false }, async () => {
      const result = checkTestPrerequisites(root);
      assert.equal(result.playwright.browsers.status, "outdated");
      assert.deepEqual(result.playwright.browsers.installedBrowsers, ["chromium-1100"], "incomplete downloads are ignored");
      assert.deepEqual(result.playwright.browsers.expectedBrowsers, ["chromium-1234", "webkit-2336"]);
      assert.deepEqual(result.playwright.browsers.configuredChannels, ["chrome"]);
      // A branded channel uses the system browser, so the run is not blocked.
      assert.equal(result.playwright.ready, true);
    });
    await writeFile(path.join(root, "playwright.config.ts"), "export default {};\n");
    await withBrowserCache({ "chromium-1100": true }, async () => {
      const result = checkTestPrerequisites(root);
      assert.equal(result.playwright.ready, false);
      assert.ok(result.nextSteps.some((step) => /do not match Playwright 1\.62\.1/.test(step)));
    });
    await withBrowserCache({ "webkit-2251": true }, async () => {
      assert.equal(checkTestPrerequisites(root).playwright.browsers.status, "installed", "platform revision overrides are accepted");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
