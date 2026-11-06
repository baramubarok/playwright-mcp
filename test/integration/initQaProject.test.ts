import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initQaProject } from "../../src/tools/initQaProject.js";
import { readQaEnv } from "../../src/lib/qaEnv.js";

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "mcp-init-qa-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const EXPECTED_FILES = [
  "package.json",
  "tsconfig.json",
  "playwright.config.ts",
  ".env.example",
  ".env",
  ".gitignore",
  "docs/test-case/README.md",
  "docs/test-case/example.feature",
  "docs/test-case/example.csv",
  "assets/README.md",
  "tests/e2e/support/diagnostics.fixture.ts",
  "tests/e2e/support/assets.ts",
];

test("creates a standalone QA project with env, docs/test-case and assets", async () => {
  await withTempDir(async (dir) => {
    const projectRoot = path.join(dir, "my-qa-repo");
    const result = initQaProject({
      projectRoot,
      baseUrl: "https://staging.example.com",
      apiUrl: "https://api.staging.example.com",
      idSelector: "cy",
    });

    assert.deepEqual(result.createdFiles, EXPECTED_FILES);
    assert.deepEqual(result.skippedFiles, []);
    assert.deepEqual(result.envTodo, []);
    assert.equal(result.env.idSelector, "cy");

    const pkg = JSON.parse(await readFile(path.join(result.projectRoot, "package.json"), "utf8"));
    assert.equal(pkg.name, "my-qa-repo");
    assert.ok(pkg.devDependencies["@playwright/test"]);

    const env = readQaEnv(result.projectRoot);
    assert.equal(env.baseUrl, "https://staging.example.com");
    assert.equal(env.apiUrl, "https://api.staging.example.com");
    assert.equal(env.testIdAttribute, "data-cy");
    assert.deepEqual(env.missingRequired, []);

    const example = await readFile(path.join(result.projectRoot, ".env.example"), "utf8");
    assert.match(example, /BASE_URL=https:\/\/staging\.example\.com/);
    assert.match(example, /TEST_PASSWORD=\n/);

    const gitignore = await readFile(path.join(result.projectRoot, ".gitignore"), "utf8");
    assert.match(gitignore, /^\.env$/m);
    assert.match(gitignore, /^\.auth\/$/m);

    const config = await readFile(path.join(result.projectRoot, "playwright.config.ts"), "utf8");
    assert.match(config, /requireEnv\('BASE_URL'\)/);
    assert.match(config, /testIdAttribute/);

    if (process.platform !== "win32") {
      assert.equal((await stat(path.join(result.projectRoot, ".env"))).mode & 0o777, 0o600);
    }
  });
});

test("flags missing URLs in envTodo and uses placeholders in .env.example", async () => {
  await withTempDir(async (dir) => {
    const result = initQaProject({ projectRoot: dir });
    assert.deepEqual(result.envTodo, ["BASE_URL", "API_URL"]);
    assert.match(await readFile(path.join(dir, ".env.example"), "utf8"), /BASE_URL=https:\/\/your-app\.example\.com/);
    assert.deepEqual(readQaEnv(dir).missingRequired, ["BASE_URL"]);
  });
});

test("skips existing files, and overwrite never replaces .env", async () => {
  await withTempDir(async (dir) => {
    initQaProject({ projectRoot: dir, baseUrl: "https://one.example.com" });
    await writeFile(path.join(dir, ".env"), "BASE_URL=https://one.example.com\nTEST_PASSWORD=secret\n");
    await writeFile(path.join(dir, "playwright.config.ts"), "// customized\n");

    const second = initQaProject({ projectRoot: dir, baseUrl: "https://two.example.com" });
    assert.deepEqual(second.createdFiles, []);
    assert.deepEqual(second.skippedFiles, EXPECTED_FILES);
    assert.equal(await readFile(path.join(dir, "playwright.config.ts"), "utf8"), "// customized\n");

    const third = initQaProject({ projectRoot: dir, baseUrl: "https://two.example.com", overwrite: true });
    assert.ok(third.createdFiles.includes("playwright.config.ts"));
    assert.ok(third.skippedFiles.includes(".env"));
    assert.match(await readFile(path.join(dir, ".env"), "utf8"), /TEST_PASSWORD=secret/);
    assert.match(await readFile(path.join(dir, "playwright.config.ts"), "utf8"), /defineConfig/);
  });
});

test("rejects relative roots, unsafe URLs and symlinked destinations before writing", async () => {
  await withTempDir(async (dir) => {
    assert.throws(() => initQaProject({ projectRoot: "relative/path" }), /absolute/);
    for (const baseUrl of ["ftp://example.com", "not a url", "https://user:pw@example.com", "https://example.com/#x", "https://example.com/\nTEST_USER=x"]) {
      assert.throws(() => initQaProject({ projectRoot: dir, baseUrl }), /baseUrl/, baseUrl);
    }

    const outside = await mkdtemp(path.join(tmpdir(), "mcp-init-qa-outside-"));
    try {
      await mkdir(path.join(dir, "docs"));
      await symlink(outside, path.join(dir, "docs", "test-case"));
      assert.throws(() => initQaProject({ projectRoot: dir }), /outside the project root|symlink/);
      await assert.rejects(stat(path.join(dir, "package.json")), /ENOENT/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
