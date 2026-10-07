import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { generateTestReport } from "../../src/tools/generateTestReport.js";

// Fake Allure 3 style JavaScript CLI; its behaviour is selected through ALLURE_FAKE_MODE.
const fakeAllureCli = `
const fs = require("node:fs");
const mode = process.env.ALLURE_FAKE_MODE;
if (mode === "hang") setTimeout(() => {}, 10000);
else if (mode === "fail") { process.stderr.write("allure: results are corrupt"); process.exit(2); }
else if (mode === "no-index") process.exit(0);
else { fs.mkdirSync("allure-report", { recursive: true }); fs.writeFileSync("allure-report/index.html", "<html></html>"); }
`;

async function makeProject(options: { results: boolean; cli: boolean }): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "mcp-allure-"));
  await writeFile(path.join(root, "package.json"), "{}\n");
  if (options.results) {
    await mkdir(path.join(root, "allure-results"));
    await writeFile(path.join(root, "allure-results", "result.json"), "{}");
  }
  if (options.cli) {
    const packageRoot = path.join(root, "node_modules", "allure");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "allure", version: "3.0.0", main: "cli.js", bin: { allure: "cli.js" } }));
    await writeFile(path.join(packageRoot, "cli.js"), fakeAllureCli);
  }
  return root;
}

async function withMode<T>(mode: string, run: () => Promise<T>): Promise<T> {
  process.env.ALLURE_FAKE_MODE = mode;
  try {
    return await run();
  } finally {
    delete process.env.ALLURE_FAKE_MODE;
  }
}

test("generates Allure with the local CLI and reports success only when the index exists", async () => {
  const root = await makeProject({ results: true, cli: true });
  try {
    const generated = await withMode("ok", () => generateTestReport({ reporter: "allure", projectRoot: root }));
    assert.equal(generated.status, "generated");
    assert.equal(generated.reportPath, path.join(root, "allure-report", "index.html"));
    assert.equal(generated.generator?.exitCode, 0);

    const failed = await withMode("fail", () => generateTestReport({ reporter: "allure", projectRoot: root }));
    assert.equal(failed.status, "generation_failed");
    assert.equal(failed.generator?.exitCode, 2);
    assert.match(failed.generator?.stderrTail ?? "", /results are corrupt/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("treats a missing index and a hung CLI as generation failures", async () => {
  const root = await makeProject({ results: true, cli: true });
  try {
    const noIndex = await withMode("no-index", () => generateTestReport({ reporter: "allure", projectRoot: root }));
    assert.equal(noIndex.status, "generation_failed");
    assert.match(noIndex.message, /index\.html was not written/);

    const hung = await withMode("hang", () => generateTestReport({ reporter: "allure", projectRoot: root }, { timeoutMs: 200 }));
    assert.equal(hung.status, "generation_failed");
    assert.equal(hung.generator?.timedOut, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("distinguishes missing results, missing CLI and locate-only reporters", async () => {
  const noResults = await makeProject({ results: false, cli: true });
  const noCli = await makeProject({ results: true, cli: false });
  const previousPath = process.env.PATH;
  try {
    assert.equal((await generateTestReport({ reporter: "allure", projectRoot: noResults })).status, "setup_required");
    process.env.PATH = "";
    const missingCli = await generateTestReport({ reporter: "allure", projectRoot: noCli });
    assert.equal(missingCli.status, "setup_required");
    assert.match(missingCli.message, /never downloaded automatically/);

    const html = await generateTestReport({ reporter: "html", projectRoot: noResults });
    assert.deepEqual([html.mode, html.status, html.exists], ["locate", "not_found", false]);
    await mkdir(path.join(noResults, "playwright-report"));
    await writeFile(path.join(noResults, "playwright-report", "index.html"), "<html></html>");
    const located = await generateTestReport({ reporter: "html", projectRoot: noResults });
    assert.deepEqual([located.status, located.exists], ["located", true]);
  } finally {
    process.env.PATH = previousPath;
    await rm(noResults, { recursive: true, force: true });
    await rm(noCli, { recursive: true, force: true });
  }
});
