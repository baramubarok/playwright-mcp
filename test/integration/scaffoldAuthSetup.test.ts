import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { initQaProject } from "../../src/tools/initQaProject.js";
import { scaffoldAuthSetup } from "../../src/tools/scaffoldAuthSetup.js";
import { scaffoldTestDomain } from "../../src/tools/scaffoldTestDomain.js";
import { checkPlaywrightConfig } from "../../src/tools/checkPlaywrightConfig.js";

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "mcp-auth-setup-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function assertValidTypeScript(source: string, label: string): void {
  const output = ts.transpileModule(source, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022 } });
  assert.deepEqual(output.diagnostics?.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")) ?? [], [], label);
}

test("ui mode creates the auth handler, patches the QA config and git-ignores .auth", async () => {
  await withTempDir(async (dir) => {
    initQaProject({ projectRoot: dir, baseUrl: "https://app.example.com" });
    const result = scaffoldAuthSetup({ projectRoot: dir, loginPath: "/sign-in" });

    assert.equal(result.mode, "ui");
    assert.deepEqual(result.createdFiles, ["tests/e2e/auth/auth.config.ts", "tests/e2e/auth/auth.page.ts", "tests/e2e/auth/auth.setup.ts"]);
    assert.equal(result.configStatus, "patched");
    assert.equal(result.configSnippet, undefined);
    assert.equal(result.authStateFile, ".auth/user.json");

    for (const file of result.createdFiles) assertValidTypeScript(await readFile(path.join(dir, file), "utf8"), file);
    const page = await readFile(path.join(dir, "tests/e2e/auth/auth.page.ts"), "utf8");
    assert.match(page, /goto\('\/sign-in'\)/);
    assert.match(page, /not\.toHaveURL\(\/\\\/sign-in\/\)/);
    const setup = await readFile(path.join(dir, "tests/e2e/auth/auth.setup.ts"), "utf8");
    assert.match(setup, /storageState\(\{ path: AUTH_FILE \}\)/);
    assert.doesNotMatch(setup, /password\s*=\s*['"]/);

    const config = await readFile(path.join(dir, "playwright.config.ts"), "utf8");
    assert.match(config, /name: 'setup', testMatch: \/\.\*\\\.setup\\\.ts\//);
    assert.match(config, /dependencies: \['setup'\]/);
    assert.match(config, /storageState: path\.resolve\(__dirname, '\.auth\/user\.json'\)/);
    assertValidTypeScript(config, "playwright.config.ts");
    assert.equal(checkPlaywrightConfig({ projectRoot: dir }).settingDetails?.baseURL.kind, "expression");

    assert.match(await readFile(path.join(dir, ".gitignore"), "utf8"), /^\.auth\/$/m);
  });
});

test("is idempotent: a second run skips files and does not patch the config twice", async () => {
  await withTempDir(async (dir) => {
    initQaProject({ projectRoot: dir, baseUrl: "https://app.example.com" });
    scaffoldAuthSetup({ projectRoot: dir });
    const configAfterFirst = await readFile(path.join(dir, "playwright.config.ts"), "utf8");
    const gitignoreAfterFirst = await readFile(path.join(dir, ".gitignore"), "utf8");

    const second = scaffoldAuthSetup({ projectRoot: dir });
    assert.deepEqual(second.createdFiles, []);
    assert.equal(second.skippedFiles.length, 3);
    assert.equal(second.configStatus, "already_configured");
    assert.equal(second.gitignoreUpdated, false);
    assert.equal(await readFile(path.join(dir, "playwright.config.ts"), "utf8"), configAfterFirst);
    assert.equal(await readFile(path.join(dir, ".gitignore"), "utf8"), gitignoreAfterFirst);
  });
});

test("api mode creates the API helper and an API based setup", async () => {
  await withTempDir(async (dir) => {
    initQaProject({ projectRoot: dir, baseUrl: "https://app.example.com", apiUrl: "https://api.example.com" });
    const result = scaffoldAuthSetup({ projectRoot: dir, mode: "api", apiLoginPath: "/auth/token" });

    assert.deepEqual(result.createdFiles, ["tests/e2e/auth/auth.config.ts", "tests/e2e/auth/auth.api.ts", "tests/e2e/auth/auth.setup.ts"]);
    for (const file of result.createdFiles) assertValidTypeScript(await readFile(path.join(dir, file), "utf8"), file);
    assert.match(await readFile(path.join(dir, "tests/e2e/auth/auth.api.ts"), "utf8"), /post\('\/auth\/token'/);
    assert.match(await readFile(path.join(dir, "tests/e2e/auth/auth.setup.ts"), "utf8"), /request\.newContext\(\{ baseURL: apiUrl \}\)/);
  });
});

test("a customized config is not rewritten; the snippet is returned instead", async () => {
  await withTempDir(async (dir) => {
    await writeFile(path.join(dir, "playwright.config.ts"), "export default { projects: [{ name: 'firefox' }] };\n");
    await writeFile(path.join(dir, ".gitignore"), "node_modules");
    const result = scaffoldAuthSetup({ projectRoot: dir });

    assert.equal(result.configStatus, "manual_required");
    assert.match(result.configSnippet ?? "", /dependencies: \['setup'\]/);
    assert.equal(await readFile(path.join(dir, "playwright.config.ts"), "utf8"), "export default { projects: [{ name: 'firefox' }] };\n");
    assert.equal(await readFile(path.join(dir, ".gitignore"), "utf8"), "node_modules\n.auth/\n");

    const noConfig = await mkdtemp(path.join(tmpdir(), "mcp-auth-noconfig-"));
    try {
      await writeFile(path.join(noConfig, "package.json"), "{}\n");
      assert.equal(scaffoldAuthSetup({ projectRoot: noConfig }).configStatus, "not_found");
    } finally {
      await rm(noConfig, { recursive: true, force: true });
    }
  });
});

test("rejects unsafe paths and symlinked destinations before writing", async () => {
  await withTempDir(async (dir) => {
    initQaProject({ projectRoot: dir, baseUrl: "https://app.example.com" });
    const { scaffoldAuthSetupSchema } = await import("../../src/tools/scaffoldAuthSetup.js");
    for (const loginPath of ["login", "/log in", "/login?next=/x", "/../etc", "/a\nb", "/${x}"]) {
      assert.equal(scaffoldAuthSetupSchema.safeParse({ loginPath }).success, false, loginPath);
    }
    assert.equal(scaffoldAuthSetupSchema.safeParse({ loginPath: "/auth/sign-in.html" }).success, true);

    const outside = await mkdtemp(path.join(tmpdir(), "mcp-auth-outside-"));
    try {
      await mkdir(path.join(dir, "tests/e2e"), { recursive: true });
      await symlink(outside, path.join(dir, "tests/e2e/auth"));
      assert.throws(() => scaffoldAuthSetup({ projectRoot: dir }), /outside the project root|symlink/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("auth-like features start logged out and scaffold the global auth handler automatically", async () => {
  await withTempDir(async (dir) => {
    initQaProject({ projectRoot: dir, baseUrl: "https://app.example.com" });
    const result = scaffoldTestDomain({ featureName: "login", projectRoot: dir });

    assert.equal(result.authFeature, true);
    assert.equal(result.authSetup?.configStatus, "patched");
    assert.deepEqual(result.authSetup?.createdFiles, ["tests/e2e/auth/auth.config.ts", "tests/e2e/auth/auth.page.ts", "tests/e2e/auth/auth.setup.ts"]);
    const spec = await readFile(path.join(dir, "tests/e2e/specs/login.spec.ts"), "utf8");
    assert.match(spec, /test\.use\(\{ storageState: \{ cookies: \[\], origins: \[\] \} \}\);/);
    assertValidTypeScript(spec, "login.spec.ts");

    const optOut = scaffoldTestDomain({ featureName: "sign-up", projectRoot: dir, withAuthSetup: false });
    assert.equal(optOut.authFeature, true);
    assert.equal(optOut.authSetup, undefined);

    const regular = scaffoldTestDomain({ featureName: "checkout", projectRoot: dir });
    assert.equal(regular.authFeature, false);
    assert.equal(regular.authSetup, undefined);
    assert.doesNotMatch(await readFile(path.join(dir, "tests/e2e/specs/checkout.spec.ts"), "utf8"), /storageState/);
  });
});
