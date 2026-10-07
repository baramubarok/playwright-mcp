import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { scaffoldTestDomain } from "../../src/tools/scaffoldTestDomain.js";
import { scoreSpecAndRelatedPOMFiles } from "../../src/lib/scoreContent.js";

test("scaffolds the expected domain files in a temporary project", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mcp-scaffold-test-"));
  try {
    const result = scaffoldTestDomain({ featureName: "checkout-flow", steps: ["payment"], projectRoot: root });
    const expectedFiles = [
      "tests/e2e/support/diagnostics.fixture.ts",
      "tests/e2e/domain/checkout-flow/pages/payment.page.ts",
      "tests/e2e/domain/checkout-flow/checkout-flow.mock.ts",
      "tests/e2e/domain/checkout-flow/checkout-flow.api.ts",
      "tests/e2e/domain/checkout-flow/checkout-flow.fixture.ts",
      "tests/e2e/factory/checkout-flow.factory.ts",
      "tests/e2e/specs/checkout-flow.spec.ts",
    ];

    assert.deepEqual(result.createdFiles, expectedFiles);
    assert.deepEqual(result.skippedFiles, []);
    for (const relativeFile of expectedFiles) {
      const content = await readFile(path.join(root, relativeFile), "utf8");
      assert.ok(content.length > 0, `${relativeFile} should not be empty`);
    }

    const spec = await readFile(path.join(root, "tests/e2e/specs/checkout-flow.spec.ts"), "utf8");
    assert.match(spec, /test\.describe\('CheckoutFlow Flow'/);
    assert.match(spec, /@smoke @ui/);
    assert.equal(result.skeleton, true);
    assert.equal(result.diagnosticsFixtureFile, "tests/e2e/support/diagnostics.fixture.ts");

    // The skeleton is explicit: tests are skipped (test.fixme) and scoring recognises the marker,
    // so commented-out examples never count as locators or assertions.
    const score = scoreSpecAndRelatedPOMFiles(path.join(root, "tests/e2e/specs/checkout-flow.spec.ts"), root);
    assert.equal(score.scaffold.skeleton, true);
    assert.equal(score.scaffold.fixmeTests, 2);
    assert.ok(score.scaffold.todoCount > 0);
    assert.equal(score.assertionDensity.testCount, 2);
    // Only real assertions count: expectLoaded() in the page object and the two toBeOK() checks in
    // the API helper. The commented-out examples in the spec are ignored.
    assert.equal(score.assertionDensity.totalAssertions, 3);
    assert.equal(score.fileBreakdown?.["tests/e2e/specs/checkout-flow.spec.ts"]?.assertionDensity.totalAssertions, 0);
    assert.match(score.warnings[0], /\[tests\/e2e\/specs\/checkout-flow\.spec\.ts\] Unimplemented scaffold skeleton/);

    const fixture = await readFile(path.join(root, "tests/e2e/support/diagnostics.fixture.ts"), "utf8");
    assert.match(fixture, /page\.on\('console'/);
    assert.match(fixture, /page\.on\('pageerror'/);
    assert.match(fixture, /page\.on\('requestfailed'/);
    assert.match(fixture, /testInfo\.attach\('mcp-diagnostics'/);

    // Every generated file must be syntactically valid TypeScript.
    for (const relativeFile of expectedFiles) {
      const source = await readFile(path.join(root, relativeFile), "utf8");
      const output = ts.transpileModule(source, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022 } });
      assert.deepEqual(output.diagnostics?.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")) ?? [], [], relativeFile);
    }

    const secondRun = scaffoldTestDomain({ featureName: "checkout-flow", steps: ["payment"], projectRoot: root });
    assert.deepEqual(secondRun.createdFiles, []);
    assert.deepEqual(secondRun.skippedFiles, expectedFiles);

    // overwrite regenerates the domain files but never clobbers the shared support fixture.
    const overwriteRun = scaffoldTestDomain({ featureName: "checkout-flow", steps: ["payment"], projectRoot: root, overwrite: true });
    assert.deepEqual(overwriteRun.skippedFiles, ["tests/e2e/support/diagnostics.fixture.ts"]);
    assert.deepEqual(overwriteRun.createdFiles, expectedFiles.slice(1));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
