import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareRunConfig, removeStaleWrappers } from "../../src/lib/runConfig.js";

test("writes a wrapper that imports the project config and appends the JSON reporter", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mcp-run-config-"));
  try {
    const configPath = path.join(root, "playwright.config.mts");
    await writeFile(configPath, "export default {};\n");
    const prepared = prepareRunConfig({ configPath, jsonReportPath: "/tmp/report.json" });
    assert.equal(prepared.strategy, "config_wrapper");
    assert.deepEqual(prepared.args, ["--config", prepared.wrapperPath]);
    assert.equal(prepared.env.PW_MCP_JSON_OUTPUT, "/tmp/report.json");
    assert.equal(prepared.env.PW_TEST_HTML_REPORT_OPEN, "never");
    assert.equal(prepared.env.PLAYWRIGHT_JSON_OUTPUT_NAME, undefined, "a project json reporter must not write into the MCP report");
    const source = await readFile(prepared.wrapperPath!, "utf8");
    assert.match(source, /import userConfigModule from "\.\/playwright\.config\.mts";/);
    assert.match(source, /\['json', \{ outputFile: process\.env\.PW_MCP_JSON_OUTPUT \}\]/);
    prepared.cleanup();
    assert.equal(existsSync(prepared.wrapperPath!), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uses --reporter=json without a config and when the wrapper cannot be written", () => {
  const withoutConfig = prepareRunConfig({ jsonReportPath: "/tmp/report.json" });
  assert.equal(withoutConfig.strategy, "cli_override");
  assert.deepEqual(withoutConfig.args, ["--reporter=json"]);
  assert.equal(withoutConfig.env.PLAYWRIGHT_JSON_OUTPUT_NAME, "/tmp/report.json");

  const unwritable = prepareRunConfig({ configPath: "/path/that/does/not/exist/playwright.config.ts", jsonReportPath: "/tmp/report.json" });
  assert.equal(unwritable.strategy, "cli_override");
  assert.match(unwritable.fallbackReason ?? "", /Could not write the temporary wrapper config/);
});

test("removes wrappers left by dead server processes but keeps live ones", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mcp-stale-wrapper-"));
  try {
    const dead = path.join(root, ".pw-mcp-999999999-0badf00d.config.ts");
    const live = path.join(root, `.pw-mcp-${process.pid}-0badf00d.config.ts`);
    const unrelated = path.join(root, ".pw-mcp-notes.txt");
    for (const file of [dead, live, unrelated]) await writeFile(file, "");
    assert.deepEqual(removeStaleWrappers(root), [dead]);
    assert.equal(existsSync(live), true);
    assert.equal(existsSync(unrelated), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
