import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseEnv, readQaEnv } from "../../src/lib/qaEnv.js";

test("parseEnv reads plain, quoted, exported and commented values", () => {
  const values = parseEnv(
    [
      "# comment",
      "BASE_URL=https://app.example.com",
      'API_URL="https://api.example.com" # trailing',
      "export ID_SELECTOR='qa'",
      "TEST_USER=user # inline comment",
      "EMPTY=",
      "not a pair",
    ].join("\n"),
  );
  assert.deepEqual(values, {
    BASE_URL: "https://app.example.com",
    API_URL: "https://api.example.com",
    ID_SELECTOR: "qa",
    TEST_USER: "user",
    EMPTY: "",
  });
});

test("readQaEnv reports missing keys and the derived test id attribute", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mcp-qa-env-"));
  try {
    const missing = readQaEnv(root);
    assert.equal(missing.envFileFound, false);
    assert.deepEqual(missing.missingRequired, ["BASE_URL"]);
    assert.equal(missing.testIdAttribute, "data-testid");

    await writeFile(path.join(root, ".env"), "BASE_URL=https://app.example.com\nID_SELECTOR=cy\nTEST_USER=\n");
    const env = readQaEnv(root);
    assert.equal(env.envFileFound, true);
    assert.deepEqual(env.missingRequired, []);
    assert.equal(env.baseUrl, "https://app.example.com");
    assert.equal(env.testIdAttribute, "data-cy");
    assert.deepEqual(env.missingOptional, ["API_URL", "TEST_USER", "TEST_PASSWORD"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
