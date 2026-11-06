import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";
import { scoreSpecAndRelatedPOMFiles } from "../../src/lib/scoreContent.js";
import { initQaProject } from "../../src/tools/initQaProject.js";
import { inspectPage } from "../../src/tools/inspectPage.js";
import { scaffoldTestDomain } from "../../src/tools/scaffoldTestDomain.js";

/**
 * Opt-in, needs a real browser (see inspectPage.test.ts): runs what the scaffold tools generate in Chromium
 * against a local app with a fake API, so the reference examples (mock, api fixture with cleanup, page object,
 * auth setup with storageState) are proven to work, not just to type-check.
 */
const workspace = process.env.PW_MCP_REAL_PLAYWRIGHT_WORKSPACE;
const skip = workspace ? false : "set PW_MCP_REAL_PLAYWRIGHT_WORKSPACE to run the generated tests in a real browser";

/** Async on purpose: the fake app server runs in this process, so a blocking spawnSync would deadlock it. */
function runCli(cli: string, cwd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "test", "--reporter=json"], { cwd, env: { ...process.env, CI: "" } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.once("error", reject);
    child.once("close", () => resolve({ stdout, stderr }));
  });
}

interface Suite {
  title: string;
  specs?: Array<{ title: string; ok: boolean; tests: Array<{ results: Array<{ status: string; error?: { message?: string } }> }> }>;
  suites?: Suite[];
}

/** Lists failing tests with the first line of their error, so a failure is understandable from the assertion message. */
function failedTests(suites: Suite[]): string {
  const lines: string[] = [];
  const walk = (suite: Suite): void => {
    for (const spec of suite.specs ?? []) {
      if (spec.ok) continue;
      const message = spec.tests.flatMap((entry) => entry.results).find((result) => result.error)?.error?.message ?? "";
      lines.push(`${suite.title} > ${spec.title}: ${message.replace(/\u001b\[[0-9;]*m/g, "").split("\n").slice(0, 6).join(" | ")}`);
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  suites.forEach(walk);
  return lines.join("\n");
}

interface Record {
  id: string;
  name: string;
  email: string;
}

const CHECKOUT_PAGE = `<!doctype html><html><head><title>Checkout</title></head><body>
<h1>Checkout</h1>
<ul id="list"></ul><p id="empty" hidden>No records yet</p>
<form id="f"><label for="n">Name</label><input id="n"><label for="e">Email</label><input id="e"><button type="submit">Save</button></form>
<div id="status" role="status"></div><div id="err" role="alert"></div>
<script>
const rows = (body) => (Array.isArray(body) ? body : body.data || []);
fetch('/api/v1/checkout').then((r) => r.json()).then((body) => {
  const list = rows(body);
  document.getElementById('empty').hidden = list.length > 0;
  document.getElementById('list').innerHTML = list.map((item) => '<li>' + item.name + '</li>').join('');
});
document.getElementById('f').addEventListener('submit', async (event) => {
  event.preventDefault();
  document.getElementById('err').textContent = '';
  const response = await fetch('/api/v1/checkout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: document.getElementById('n').value, email: document.getElementById('e').value }) });
  const body = await response.json().catch(() => ({}));
  if (response.ok) document.getElementById('status').textContent = 'Success: saved';
  else if (response.status === 422) document.getElementById('err').textContent = Object.values(body.errors || {}).join(', ');
  else document.getElementById('err').textContent = 'Server error: ' + (body.message || response.status);
});
</script></body></html>`;

const LOGIN_PAGE = `<!doctype html><html><head><title>Sign in</title></head><body><h1>Sign in</h1>
<form method="post" action="/login"><label for="u">Username</label><input id="u" name="u"><label for="p">Password</label><input id="p" name="p" type="password"><button type="submit">Log in</button></form></body></html>`;

function startApp(): Promise<{ origin: string; records: Map<string, Record>; close: () => void }> {
  const records = new Map<string, Record>();
  let counter = 0;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://x");
    const send = (status: number, body: string, type = "application/json", headers: http.OutgoingHttpHeaders = {}) => {
      response.writeHead(status, { "content-type": type, ...headers });
      response.end(body);
    };
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      if (url.pathname === "/checkout") return send(200, CHECKOUT_PAGE, "text/html");
      if (url.pathname === "/login" && request.method === "GET") return send(200, LOGIN_PAGE, "text/html");
      if (url.pathname === "/login" && request.method === "POST") {
        const form = new URLSearchParams(raw);
        if (form.get("u") === "qa-user" && form.get("p") === "s3cret") return send(302, "", "text/plain", { location: "/home", "set-cookie": "session=1; Path=/" });
        return send(401, "denied", "text/plain");
      }
      if (url.pathname === "/home") {
        if (!(request.headers.cookie ?? "").includes("session=1")) return send(302, "", "text/plain", { location: "/login" });
        return send(200, "<h1>Logged in</h1><button data-qa=\"logout\">Log out</button>", "text/html");
      }
      if (url.pathname === "/api/v1/checkout" && request.method === "GET") return send(200, JSON.stringify([...records.values()]));
      if (url.pathname === "/api/v1/checkout" && request.method === "POST") {
        const body = JSON.parse(raw || "{}") as { name: string; email: string };
        const record = { id: `r${++counter}`, name: body.name, email: body.email };
        records.set(record.id, record);
        return send(201, JSON.stringify(record));
      }
      const match = url.pathname.match(/^\/api\/v1\/checkout\/(\w+)$/);
      if (match && request.method === "GET") return records.has(match[1]) ? send(200, JSON.stringify(records.get(match[1]))) : send(404, "{}");
      if (match && request.method === "DELETE") return records.delete(match[1]) ? send(200, "{}") : send(404, "{}");
      return send(404, "{}");
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, records, close: () => server.close() })),
  );
}

test("generated QA project runs in a real browser: auth setup, mocked UI tests and API integration tests", { skip, timeout: 300_000 }, async () => {
  const app = await startApp();
  const root = await mkdtemp(path.join(workspace as string, "workflow-"));
  try {
    initQaProject({ projectRoot: root, baseUrl: app.origin, apiUrl: app.origin });
    await writeFile(path.join(root, ".env"), `BASE_URL=${app.origin}\nAPI_URL=${app.origin}\nID_SELECTOR=qa\nTEST_USER=qa-user\nTEST_PASSWORD=s3cret\n`);

    const checkout = scaffoldTestDomain({ featureName: "checkout", projectRoot: root });
    const login = scaffoldTestDomain({ featureName: "login", projectRoot: root, testTypes: ["smoke"] });
    assert.equal(login.authSetup?.configStatus, "patched");

    // Turn the reference examples into real tests (what an author does after adapting them).
    const specPath = path.join(root, checkout.specFile);
    const skeleton = await readFile(specPath, "utf8");
    const implemented = skeleton.replace(/test\.fixme\(/g, "test(").split("\n").filter((line) => !/^\/\/ /.test(line)).join("\n");
    await writeFile(specPath, implemented);
    await writeFile(
      path.join(root, "tests/e2e/specs/session.spec.ts"),
      `import { test, expect } from '@playwright/test';\ntest.describe('session', () => {\n  test('reuses the saved login', async ({ page }) => {\n    await test.step('open a protected page', async () => {\n      await page.goto('/home');\n    });\n    await test.step('assert logged in', async () => {\n      await expect(page.getByRole('heading', { name: 'Logged in' })).toBeVisible();\n    });\n  });\n});\n`,
    );

    const score = scoreSpecAndRelatedPOMFiles(specPath, root);
    assert.equal(score.scaffold.skeleton, false);
    assert.equal(score.antiPatterns.inlineApiCall + score.antiPatterns.inlineRoute + score.antiPatterns.integrationWithoutApiHelper, 0);

    const cli = path.join(workspace as string, "node_modules", "@playwright", "test", "cli.js");
    const run = await runCli(cli, root);
    const report = JSON.parse(run.stdout) as { stats: { expected: number; unexpected: number; flaky: number; skipped: number }; suites: Suite[] };
    assert.equal(report.stats.unexpected, 0, failedTests(report.suites));
    assert.equal(report.stats.flaky, 0);
    // 7 checkout examples + login setup + session spec; the login spec stays test.fixme.
    assert.equal(report.stats.expected, 9, run.stderr);
    assert.equal(report.stats.skipped, 1);

    // The API fixture removed everything it created, and the record the UI created was removed by the test itself.
    assert.equal(app.records.size, 0, `leftover records: ${JSON.stringify([...app.records.values()])}`);

    // Scraping with the saved session sees the protected page; without it the app redirects to the login form.
    const withAuth = await inspectPage({ projectRoot: root, url: "/home", useAuth: true });
    assert.equal(withAuth.authUsed, true);
    assert.ok(withAuth.states[0].elements.some((element) => element.locator === "page.getByTestId('logout')" && element.source === "data-qa"), JSON.stringify(withAuth.states[0].elements));
    assert.ok(withAuth.states[0].elements.some((element) => element.name === "Logged in"));
    const withoutAuth = await inspectPage({ projectRoot: root, url: "/home" });
    assert.match(withoutAuth.states[0].url, /\/login$/);
    assert.ok(withoutAuth.states[0].elements.some((element) => element.locator === "page.getByLabel('Password')"));
  } finally {
    app.close();
    if (!process.env.PW_MCP_KEEP) await rm(root, { recursive: true, force: true });
    else console.log("kept project at " + root);
  }
});
