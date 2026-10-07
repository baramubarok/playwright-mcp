import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, lstatSync } from "node:fs";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { scaffoldTestDomain } from "../../src/tools/scaffoldTestDomain.js";

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "mcp-scaffold-security-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("rejects unsafe feature and step names before creating any output", async () => {
  await withRoot(async (root) => {
    assert.throws(() => scaffoldTestDomain({ featureName: "../outside", projectRoot: root }), /Invalid featureName/);
    assert.equal(existsSync(path.join(root, "tests")), false);

    assert.throws(() => scaffoldTestDomain({ featureName: "checkout", steps: ["payment/../outside"], projectRoot: root }), /Invalid steps\[0\]/);
    assert.equal(existsSync(path.join(root, "tests")), false);
  });
});

test("preflights symlink destinations before mkdir/write", async () => {
  await withRoot(async (root) => {
    const outside = await mkdtemp(path.join(tmpdir(), "mcp-scaffold-outside-"));
    try {
      await symlink(outside, path.join(root, "tests"));
      assert.throws(() => scaffoldTestDomain({ featureName: "checkout", projectRoot: root }), /outside the project root|symlink/);
      assert.equal(lstatSync(path.join(root, "tests")).isSymbolicLink(), true);
      assert.equal(existsSync(path.join(outside, "e2e")), false);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("rejects duplicate steps that would generate the same page file", async () => {
  await withRoot(async (root) => {
    assert.throws(
      () => scaffoldTestDomain({ featureName: "checkout", steps: ["paymentStep", "payment-step"], projectRoot: root }),
      /duplicates another value after normalization/,
    );
    assert.equal(existsSync(path.join(root, "tests")), false);
  });
});

test("valid scaffolding still writes the complete expected structure", async () => {
  await withRoot(async (root) => {
    const result = scaffoldTestDomain({ featureName: "safe-checkout", steps: ["payment"], projectRoot: root });
    assert.equal(result.createdFiles.length, 7);
    assert.match(await readFile(path.join(root, result.specFile), "utf8"), /SafeCheckout Flow/);
  });
});
