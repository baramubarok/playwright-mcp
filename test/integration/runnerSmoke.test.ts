import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runPlaywrightTest } from "../../src/tools/runPlaywrightTest.js";

test("reports a clear error when the requested spec does not exist", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mcp-runner-test-"));
  try {
    await writeFile(path.join(root, "package.json"), "{}\n");
    await assert.rejects(
      () => runPlaywrightTest({ specPath: "missing.spec.ts", projectRoot: root }),
      /Spec file not found: missing\.spec\.ts/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("returns setup_required before executing a spec when Playwright is unavailable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mcp-runner-preflight-"));
  try {
    await writeFile(path.join(root, "package.json"), "{}\n");
    await writeFile(path.join(root, "example.spec.ts"), "test('example', async () => {});\n");
    const result = await runPlaywrightTest({ specPath: "example.spec.ts", projectRoot: root });
    assert.equal(result.status, "setup_required");
    assert.equal(result.durationMs, 0);
    assert.equal(result.prerequisites?.playwright.packageInstalled, false);
    assert.equal(result.tests.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
