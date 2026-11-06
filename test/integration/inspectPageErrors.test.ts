import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initQaProject } from "../../src/tools/initQaProject.js";
import { inspectPage, inspectPageSchema } from "../../src/tools/inspectPage.js";

async function withProject<T>(run: (root: string) => Promise<T>, baseUrl = "https://app.example.com"): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "mcp-inspect-"));
  try {
    initQaProject({ projectRoot: root, baseUrl, apiUrl: "https://api.example.com" });
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("fails before launching anything when BASE_URL is missing or the origin is not allowed", async () => {
  await withProject(async (root) => {
    await assert.rejects(inspectPage({ projectRoot: root, url: "https://evil.example.org/" }), /Origin https:\/\/evil\.example\.org is not allowed/);
    await assert.rejects(inspectPage({ projectRoot: root, url: "/x", steps: [{ action: "goto", url: "http://169.254.169.254/latest" }] }), /is not allowed/);
    await assert.rejects(inspectPage({ projectRoot: root, url: "/x", allowedOrigins: ["file:///etc"] }), /http or https/);
  });
  await withProject(async (root) => {
    await writeFile(path.join(root, ".env"), "API_URL=https://api.example.com\n");
    await assert.rejects(inspectPage({ projectRoot: root }), /BASE_URL is not set in \.env/);
  }, "");
});

test("credential placeholders require TEST_USER/TEST_PASSWORD before the browser starts", async () => {
  await withProject(async (root) => {
    await assert.rejects(
      inspectPage({ projectRoot: root, url: "/login", steps: [{ action: "fill", target: "#user", value: "{{TEST_USER}}" }] }),
      /TEST_USER must be set in \.env/,
    );
  });
});

test("reports a clear error when the project has no Playwright installed", async () => {
  await withProject(async (root) => {
    await assert.rejects(inspectPage({ projectRoot: root, url: "/", timeoutMs: 20_000 }), (error: Error & { code?: string }) => {
      assert.equal(error.code, "PLAYWRIGHT_NOT_INSTALLED");
      assert.match(error.message, /Playwright was not found in this project/);
      return true;
    });
  });
});

test("input schema bounds steps, keys, timeouts and element limits", () => {
  const ok = inspectPageSchema.safeParse({ url: "/login", steps: [{ action: "press", target: "#a", key: "Control+A" }, { action: "snapshot" }], maxElements: 60 });
  assert.equal(ok.success, true);
  for (const bad of [
    { steps: Array.from({ length: 21 }, () => ({ action: "snapshot" })) },
    { steps: [{ action: "press", target: "#a", key: "Enter; rm -rf" }] },
    { steps: [{ action: "evaluate", target: "#a" }] },
    { steps: [{ action: "fill", target: "#a" }] },
    { steps: [{ action: "click", target: "" }] },
    { maxElements: 1000 },
    { timeoutMs: 100 },
    { browser: "safari" },
  ]) {
    assert.equal(inspectPageSchema.safeParse(bad).success, false, JSON.stringify(bad));
  }
});
