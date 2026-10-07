import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveProjectPath, PathSecurityError } from "../../src/lib/pathSecurity.js";

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "mcp-path-security-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("resolves valid paths and rejects lexical traversal and sibling-prefix bypasses", async () => {
  await withRoot(async (root) => {
    await writeFile(path.join(root, "inside.txt"), "safe\n");

    assert.equal(resolveProjectPath("inside.txt", root, { mustExist: true, expectedType: "file" }), path.join(root, "inside.txt"));
    assert.throws(() => resolveProjectPath("../outside.txt", root), PathSecurityError);
    assert.throws(() => resolveProjectPath(path.join(path.dirname(root), `${path.basename(root)}-evil`), root), PathSecurityError);
    assert.throws(() => resolveProjectPath("inside\0.txt", root), /null byte/);
  });
});

test("allows a new safe child path but rejects a symlink that escapes the root", async () => {
  await withRoot(async (root) => {
    const outside = await mkdtemp(path.join(tmpdir(), "mcp-path-outside-"));
    try {
      assert.equal(resolveProjectPath("new/nested/file.ts", root), path.join(root, "new/nested/file.ts"));
      await symlink(outside, path.join(root, "linked"));
      assert.throws(() => resolveProjectPath("linked/secret.txt", root), PathSecurityError);
      assert.throws(() => resolveProjectPath("linked", root, { forWrite: true }), /symlink/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
