import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { initQaProject } from "../../src/tools/initQaProject.js";
import { inspectPage } from "../../src/tools/inspectPage.js";

/**
 * Opt-in: drives a real headless browser against a local HTML server. Uses the lab from
 * realPlaywright.test.ts (PW_MCP_REAL_PLAYWRIGHT_WORKSPACE) with @playwright/test and a matching
 * browser installed (e.g. npx playwright install chromium-headless-shell). No internet is needed.
 */
const workspace = process.env.PW_MCP_REAL_PLAYWRIGHT_WORKSPACE;
const skip = workspace ? false : "set PW_MCP_REAL_PLAYWRIGHT_WORKSPACE to inspect a local page with a real browser";

const LOGIN_PAGE = `<!doctype html><html><head><title>Sign in</title></head><body>
<h1>Welcome back</h1>
<form id="f" onsubmit="event.preventDefault(); document.getElementById('err').hidden = false; document.getElementById('err').textContent = 'Wrong password for ' + document.getElementById('user').value;">
  <label for="user">Username</label><input id="user" name="user" data-cy="login-user">
  <label for="pass">Password</label><input id="pass" type="password" name="pass">
  <input placeholder="Search docs" data-testid="search">
  <button type="submit" data-qa="submit">Sign in</button>
  <button type="button" id="open">Forgot password?</button>
</form>
<div id="err" role="alert" hidden></div>
<div role="dialog" id="dlg" hidden aria-label="Reset password"><label for="mail">Email</label><input id="mail" type="email"><button type="button">Send link</button></div>
<ul><li><button>Remove</button></li><li><button>Remove</button></li><li><button>Remove</button></li></ul>
<a href="/help">Help center</a>
<a href="EXTERNAL">Leave</a>
<button style="display:none" data-qa="invisible">Hidden</button>
<input type="file" aria-label="Upload avatar">
<iframe srcdoc="<button>inside frame</button>"></iframe>
<script>document.getElementById('open').addEventListener('click', function(){ document.getElementById('dlg').hidden = false; });</script>
</body></html>`;

async function withServer<T>(run: (origin: string, external: string) => Promise<T>): Promise<T> {
  const external = http.createServer((_, response) => response.end("external"));
  await new Promise<void>((resolve) => external.listen(0, "127.0.0.1", resolve));
  const externalOrigin = `http://127.0.0.1:${(external.address() as AddressInfo).port}`;
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "text/html");
    if (request.url === "/login") response.end(LOGIN_PAGE.replace("EXTERNAL", externalOrigin));
    else if (request.url === "/help") response.end("<h1>Help</h1>");
    else response.end("<h1>Home</h1>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, externalOrigin);
  } finally {
    server.close();
    external.close();
  }
}

async function withProject<T>(origin: string, run: (root: string) => Promise<T>, env: { user?: string; password?: string } = {}): Promise<T> {
  const root = await mkdtemp(path.join(workspace as string, "inspect-"));
  try {
    initQaProject({ projectRoot: root, baseUrl: origin, idSelector: "cy" });
    if (env.user) await writeFile(path.join(root, ".env"), `BASE_URL=${origin}\nID_SELECTOR=cy\nTEST_USER=${env.user}\nTEST_PASSWORD=${env.password}\n`);
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("inspect_page lists elements with the best locator and flags ambiguity", { skip, timeout: 120_000 }, async () => {
  await withServer(async (origin) => {
    await withProject(origin, async (root) => {
      const result = await inspectPage({ projectRoot: root, url: "/login" });
      assert.equal(result.testIdAttribute, "data-cy");
      assert.equal(result.states.length, 1);
      const [state] = result.states;
      assert.equal(state.title, "Sign in");
      assert.equal(state.httpStatus, 200);
      const locators = new Map(state.elements.map((element) => [element.locator, element]));

      // data-cy is the configured testIdAttribute -> getByTestId; data-testid needs the helper; data-qa too.
      assert.equal(locators.get("page.getByTestId('login-user')")?.source, "data-env-id");
      assert.equal(locators.get("byTestId(page, 'search')")?.source, "data-testid");
      assert.equal(locators.get("byQa(page, 'submit')")?.source, "data-qa");
      // No data attribute: semantic fallbacks.
      assert.equal(locators.get("page.getByRole('heading', { name: 'Welcome back' })")?.source, "role");
      assert.equal(locators.get("page.getByLabel('Password')")?.source, "label");
      assert.ok(locators.has("page.getByRole('link', { name: 'Help center' })"));
      assert.equal(locators.get("page.getByRole('link', { name: 'Help center' })")?.href, "/help");
      assert.ok(locators.has("page.getByLabel('Upload avatar')") || locators.has("page.getByRole('button', { name: 'Upload avatar' })"));

      const remove = locators.get("page.getByRole('button', { name: 'Remove' })");
      assert.equal(remove?.ambiguous, true);
      assert.equal(remove?.count, 3);
      assert.ok(![...locators.keys()].some((locator) => /invisible|Hidden/.test(locator)), "hidden elements are not listed");
      assert.ok(![...locators.keys()].some((locator) => /Reset password|Send link/.test(locator)), "the hidden dialog is not listed yet");

      assert.equal(state.iframeCount, 1);
      assert.ok(result.hints.some((hint) => /scope them inside a container/.test(hint)));
      assert.ok(result.hints.some((hint) => /iframe/.test(hint)));
      assert.ok(result.hints.some((hint) => /Import byQa, byTestId from tests\/e2e\/support\/selectors/.test(hint)));
      assert.ok(state.ariaSnapshot === undefined || state.ariaSnapshot.includes("Welcome back"));
    });
  });
});

test("steps reach other states, credentials are typed from .env and redacted from the output", { skip, timeout: 120_000 }, async () => {
  await withServer(async (origin) => {
    await withProject(
      origin,
      async (root) => {
        const result = await inspectPage({
          projectRoot: root,
          url: "/login",
          steps: [
            { action: "click", target: "role=button[name='Forgot password?']" },
            { action: "waitFor", target: "role=dialog" },
            { action: "snapshot", label: "reset dialog" },
            { action: "fill", target: "#user", value: "{{TEST_USER}}" },
            { action: "fill", target: "#pass", value: "{{TEST_PASSWORD}}" },
            { action: "click", target: "[data-qa=submit]" },
            { action: "waitFor", target: "role=alert" },
          ],
        });

        assert.deepEqual(result.states.map((state) => state.label), ["initial", "reset dialog", "final"]);
        assert.ok(result.steps.every((step) => step.ok), JSON.stringify(result.steps));
        const dialog = result.states[1].elements.map((element) => element.locator);
        assert.ok(dialog.includes("page.getByLabel('Email')") || dialog.includes("page.getByRole('textbox', { name: 'Email' })"));
        assert.ok(dialog.includes("page.getByRole('button', { name: 'Send link' })"));

        const finalState = result.states[2];
        assert.ok(finalState.elements.some((element) => element.role === "alert" && element.name?.includes("Wrong password for")));
        const output = JSON.stringify(result);
        assert.ok(!output.includes("s3cret-pw"), "password must never appear");
        assert.ok(!output.includes("qa-user@example.com"), "the TEST_USER value is redacted too");
        assert.ok(output.includes("{{redacted}}"));
      },
      { user: "qa-user@example.com", password: "s3cret-pw" },
    );
  });
});

test("failed steps are reported with a snapshot; navigation outside the allowed origins is blocked", { skip, timeout: 120_000 }, async () => {
  await withServer(async (origin, external) => {
    await withProject(origin, async (root) => {
      const failed = await inspectPage({
        projectRoot: root,
        url: "/login",
        steps: [
          { action: "click", target: "role=button[name='Does not exist']" },
          { action: "click", target: "text=never reached" },
        ],
        timeoutMs: 60_000,
      });
      assert.equal(failed.steps.length, 1, "execution stops at the first failing step");
      assert.equal(failed.steps[0].ok, false);
      assert.match(failed.steps[0].error ?? "", /Timeout|waiting/i);
      assert.equal(failed.states[failed.states.length - 1].label, "failed at step 1");

      const blocked = await inspectPage({ projectRoot: root, url: "/login", steps: [{ action: "click", target: "text=Leave" }] });
      assert.deepEqual(blocked.blockedOrigins, [external]);
      assert.ok(blocked.warnings.some((warning) => warning.includes(`Navigation to ${external} was blocked`)));
      assert.equal(blocked.steps[0].ok, false);
      assert.match(blocked.steps[0].error ?? "", /was blocked: origin not allowed/);
      assert.ok(blocked.states.every((state) => state.url.startsWith(origin)), blocked.states.map((state) => state.url).join(", "));
      assert.equal(blocked.states[blocked.states.length - 1].label, "failed at step 1");

      await assert.rejects(inspectPage({ projectRoot: root, url: external + "/login" }), /Origin .* is not allowed/);
      await assert.rejects(inspectPage({ projectRoot: root, url: "/login", steps: [{ action: "goto", url: external }] }), /is not allowed/);
      const allowed = await inspectPage({ projectRoot: root, url: external + "/", allowedOrigins: [external] });
      assert.equal(allowed.states[0].httpStatus, 200);
    });
  });
});

test("useAuth without a saved session warns and continues; missing placeholders fail early", { skip, timeout: 120_000 }, async () => {
  await withServer(async (origin) => {
    await withProject(origin, async (root) => {
      const result = await inspectPage({ projectRoot: root, url: "/", useAuth: true, includeAriaSnapshot: false });
      assert.equal(result.authUsed, false);
      assert.ok(result.warnings.some((warning) => /\.auth\/user\.json does not exist/.test(warning)));
      assert.equal(result.states[0].ariaSnapshot, undefined);

      await assert.rejects(
        inspectPage({ projectRoot: root, url: "/login", steps: [{ action: "fill", target: "#user", value: "{{TEST_USER}}" }] }),
        /TEST_USER and TEST_PASSWORD must be set in \.env|TEST_USER must be set/,
      );
    });
  });
});
