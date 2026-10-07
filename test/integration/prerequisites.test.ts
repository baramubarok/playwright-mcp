import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkTestPrerequisitesTool } from "../../src/tools/checkTestPrerequisites.js";

test("preflight tool returns actionable setup information for an explicit project root", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mcp-prerequisites-integration-"));
  try {
    await writeFile(path.join(root, "package.json"), "{}\n");
    const result = checkTestPrerequisitesTool({ projectRoot: root });
    assert.equal(result.projectRoot, root);
    assert.equal(result.playwright.status, "setup_required");
    assert.ok(result.nextSteps.length > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
