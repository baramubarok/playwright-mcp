import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { initQaProject } from "../../src/tools/initQaProject.js";
import { scaffoldTestDomain } from "../../src/tools/scaffoldTestDomain.js";
import { scaffoldAuthSetup } from "../../src/tools/scaffoldAuthSetup.js";

/**
 * Opt-in: type-checks everything the scaffold tools generate against the real @playwright/test types.
 * Uses the same lab as realPlaywright.test.ts (PW_MCP_REAL_PLAYWRIGHT_WORKSPACE) and needs typescript,
 * @types/node, dotenv and @playwright/test in its node_modules; no browsers are required.
 */
const workspace = process.env.PW_MCP_REAL_PLAYWRIGHT_WORKSPACE;
const skip = workspace ? false : "set PW_MCP_REAL_PLAYWRIGHT_WORKSPACE to type-check scaffold output";

test("scaffold output type-checks against real Playwright types", { skip }, async () => {
  const root = await mkdtemp(path.join(workspace as string, "typecheck-"));
  try {
    initQaProject({ projectRoot: root, baseUrl: "https://app.example.com", apiUrl: "https://api.example.com", idSelector: "cy" });
    scaffoldTestDomain({ featureName: "checkout", steps: ["payment", "review"], projectRoot: root });
    scaffoldTestDomain({ featureName: "login", projectRoot: root });
    scaffoldAuthSetup({ projectRoot: root, mode: "api", overwrite: true });

    const tsc = path.join(workspace as string, "node_modules", "typescript", "bin", "tsc");
    assert.ok(existsSync(tsc), "typescript must be installed in the workspace");
    const result = spawnSync(process.execPath, [tsc, "--noEmit", "-p", path.join(root, "tsconfig.json")], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
