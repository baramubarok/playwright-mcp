import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { scaffoldTestDomain, scaffoldTestDomainSchema } from "../../src/tools/scaffoldTestDomain.js";
import { scoreSpecAndRelatedPOMFiles } from "../../src/lib/scoreContent.js";

async function withRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "mcp-domain-templates-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function parse(source: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** Public class properties and methods, or exported function names, as the spec author would see them. */
function declaredMembers(source: string, fileName: string): string[] {
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node)) {
      for (const member of node.members) {
        const hidden = (ts.getModifiers(member) ?? []).some((m) => m.kind === ts.SyntaxKind.PrivateKeyword);
        if (hidden || !member.name || !ts.isIdentifier(member.name)) continue;
        if (ts.isMethodDeclaration(member) || (ts.isPropertyDeclaration(member) && member.name.text !== "page")) names.push(member.name.text);
      }
    }
    if (ts.isFunctionDeclaration(node) && node.name && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      names.push(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(source, fileName));
  return names.sort();
}

const bareName = (member: string) => member.replace(/\(.*$/, "");

test("helperCatalog lists exactly what the generated files declare", async () => {
  await withRoot(async (root) => {
    const result = scaffoldTestDomain({ featureName: "order-history", steps: ["list", "detail"], projectRoot: root });
    assert.equal(result.helperCatalog.filter((entry) => entry.kind === "page").length, 2);

    for (const entry of result.helperCatalog) {
      const source = await readFile(path.join(root, entry.file), "utf8");
      assert.deepEqual(declaredMembers(source, entry.file), entry.members.map(bareName).sort(), entry.file);
    }
    const fixtures = result.helperCatalog.flatMap((entry) => (entry.fixture ? [entry.fixture] : []));
    assert.deepEqual(fixtures, ["listPage", "detailPage", "orderHistoryMock", "orderHistoryApi"]);
  });
});

test("example tests only call helpers that exist and never inline API or route handlers", async () => {
  await withRoot(async (root) => {
    const result = scaffoldTestDomain({ featureName: "checkout", steps: ["payment"], projectRoot: root });
    const specPath = path.join(root, result.specFile);
    const spec = await readFile(specPath, "utf8");

    for (const tag of ["@smoke", "@ui", "@regression", "@integration"]) assert.ok(spec.includes(tag), tag);
    assert.equal((spec.match(/test\.fixme\(/g) ?? []).length, 7);

    // Every fixture.method(...) used in the spec is part of the catalog.
    for (const entry of result.helperCatalog.filter((candidate) => candidate.fixture)) {
      const allowed = new Set(entry.members.map(bareName));
      const used = [...spec.matchAll(new RegExp(`\\b${entry.fixture}\\.(\\w+)`, "g"))].map((match) => match[1]);
      assert.ok(used.length > 0, `${entry.fixture} should be demonstrated in the spec`);
      for (const member of used) assert.ok(allowed.has(member), `${entry.fixture}.${member} is not in the helper catalog`);
    }

    const score = scoreSpecAndRelatedPOMFiles(specPath, root);
    assert.equal(score.antiPatterns.inlineApiCall, 0);
    assert.equal(score.antiPatterns.inlineRoute, 0);
    assert.equal(score.antiPatterns.integrationWithoutApiHelper, 0);
    assert.equal(score.antiPatterns.unusedDomainHelpers, 0, "skeletons are exempt from the unused-helper warning");
    assert.equal(score.scaffold.skeleton, true);
  });
});

test("the integration examples use the api fixture to arrange and verify, and the fixture cleans up", async () => {
  await withRoot(async (root) => {
    scaffoldTestDomain({ featureName: "checkout", projectRoot: root });
    const spec = await readFile(path.join(root, "tests/e2e/specs/checkout.spec.ts"), "utf8");
    assert.match(spec, /checkoutApi\.create\(/);
    assert.match(spec, /checkoutApi\.getById\(/);
    assert.match(spec, /checkoutApi\.list\(/);
    assert.match(spec, /checkoutApi\.remove\(/);
    assert.match(spec, /checkoutMock\.mockValidationError\(/);
    assert.match(spec, /checkoutMock\.waitForRequest\('POST'\)/);

    const fixture = await readFile(path.join(root, "tests/e2e/domain/checkout/checkout.fixture.ts"), "utf8");
    assert.match(fixture, /process\.env\.API_URL/);
    assert.match(fixture, /finally \{\s*await api\.cleanup\(\);\s*await context\.dispose\(\);/);
    const api = await readFile(path.join(root, "tests/e2e/domain/checkout/checkout.api.ts"), "utf8");
    assert.match(api, /createdIds\.push\(record\.id\)/);
    const page = await readFile(path.join(root, "tests/e2e/domain/checkout/pages/checkout.page.ts"), "utf8");
    assert.match(page, /assetPath\(fileName\)/);
  });
});

test("testTypes limits the reference tests and apiBasePath drives the mock pattern and api path", async () => {
  await withRoot(async (root) => {
    const result = scaffoldTestDomain({ featureName: "profile", testTypes: ["smoke", "ui"], apiBasePath: "/internal/v2/profile.json", projectRoot: root });
    const spec = await readFile(path.join(root, result.specFile), "utf8");
    assert.equal((spec.match(/test\.fixme\(/g) ?? []).length, 4);
    assert.doesNotMatch(spec, /test\.fixme\('[^']*@(?:regression|integration)/);
    assert.doesNotMatch(spec, /profileApi\.\w/);

    const mock = await readFile(path.join(root, "tests/e2e/domain/profile/profile.mock.ts"), "utf8");
    assert.match(mock, /profileApiPattern = \/\\\/internal\\\/v2\\\/profile\\\.json\(\?:\[\/\?#\]\|\$\)\//);
    const pattern = new RegExp("\\/internal\\/v2\\/profile\\.json(?:[/?#]|$)");
    assert.ok(pattern.test("https://x.test/internal/v2/profile.json?x=1"));
    assert.ok(!pattern.test("https://x.test/internal/v2/profileXjson"));
    assert.match(await readFile(path.join(root, "tests/e2e/domain/profile/profile.api.ts"), "utf8"), /BASE_PATH = '\/internal\/v2\/profile\.json'/);

    for (const apiBasePath of ["api/v1", "/api/../x", "/api?x=1", "/a b", "/${x}"]) {
      assert.equal(scaffoldTestDomainSchema.safeParse({ featureName: "x", apiBasePath }).success, false, apiBasePath);
    }
    assert.equal(scaffoldTestDomainSchema.safeParse({ featureName: "x", testTypes: ["load"] }).success, false);
  });
});

test("auth features keep the logged-out reference spec valid", async () => {
  await withRoot(async (root) => {
    const result = scaffoldTestDomain({ featureName: "login", projectRoot: root, withAuthSetup: false });
    const spec = await readFile(path.join(root, result.specFile), "utf8");
    assert.match(spec, /test\.describe\('Login Flow', \(\) => \{\s*\/\/ Start logged out/);
    const output = ts.transpileModule(spec, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022 } });
    assert.deepEqual(output.diagnostics, []);
  });
});
