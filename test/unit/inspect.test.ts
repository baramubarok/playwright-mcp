import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { buildOriginPolicy, resolveInspectUrl, usesSecretPlaceholder } from "../../src/lib/inspect/origins.js";
import { chooseLocator, quote, stableAttributes, summarizeElements, type RawElement, type SelectorConfig } from "../../src/lib/inspect/selectors.js";
import { INSPECT_CHILD_SCRIPT } from "../../src/lib/inspect/childScript.js";
import { redactSecrets } from "../../src/tools/inspectPage.js";

const plain: SelectorConfig = { testIdAttribute: "data-testid" };
const custom: SelectorConfig = { idSelector: "cy", testIdAttribute: "data-cy" };
const el = (partial: Partial<RawElement>): RawElement => ({ tag: "button", attrs: {}, ...partial });

test("stableAttributes lists data-testid, data-qa and data-{ID_SELECTOR} once, in priority order", () => {
  assert.deepEqual(stableAttributes(), ["data-testid", "data-qa"]);
  assert.deepEqual(stableAttributes("cy"), ["data-testid", "data-qa", "data-cy"]);
  assert.deepEqual(stableAttributes("qa"), ["data-testid", "data-qa"]);
});

test("chooseLocator follows data-testid > data-qa > data-{ID} > role > label > placeholder > text", () => {
  const all = el({
    role: "button",
    name: "Save",
    label: "Save label",
    placeholder: "ph",
    text: "txt",
    attrs: { "data-testid": "t", "data-qa": "q", "data-cy": "c" },
  });
  assert.equal(chooseLocator(all, plain)?.code, "page.getByTestId('t')");
  assert.equal(chooseLocator(all, custom)?.code, "byTestId(page, 't')");
  assert.equal(chooseLocator({ ...all, attrs: { "data-qa": "q", "data-cy": "c" } }, plain)?.code, "byQa(page, 'q')");
  assert.equal(chooseLocator({ ...all, attrs: { "data-qa": "q", "data-cy": "c" } }, { testIdAttribute: "data-qa", idSelector: "qa" })?.code, "page.getByTestId('q')");
  assert.deepEqual(chooseLocator({ ...all, attrs: { "data-cy": "c" } }, custom), { code: "page.getByTestId('c')", source: "data-env-id", attribute: "data-cy" });
  assert.equal(chooseLocator({ ...all, attrs: { "data-cy": "c" } }, { idSelector: "cy", testIdAttribute: "data-testid" })?.code, "byEnvId(page, 'c')");

  const semantic = { ...all, attrs: {} };
  assert.deepEqual(chooseLocator(semantic, plain), { code: "page.getByRole('button', { name: 'Save' })", source: "role" });
  assert.equal(chooseLocator({ ...semantic, role: undefined, name: undefined }, plain)?.code, "page.getByLabel('Save label')");
  assert.equal(chooseLocator({ ...semantic, role: undefined, name: undefined, label: undefined }, plain)?.code, "page.getByPlaceholder('ph')");
  assert.equal(chooseLocator({ ...semantic, role: undefined, name: undefined, label: undefined, placeholder: undefined }, plain)?.code, "page.getByText('txt', { exact: true })");
  assert.equal(chooseLocator(el({}), plain), undefined);
});

test("form controls with only an aria-label use getByLabel, but placeholder-derived names do not", () => {
  const upload = el({ tag: "input", type: "file", name: "Upload avatar" });
  assert.equal(chooseLocator(upload, plain)?.code, "page.getByLabel('Upload avatar')");
  const search = el({ tag: "input", type: "text", name: "Search docs", placeholder: "Search docs" });
  assert.equal(chooseLocator(search, plain)?.code, "page.getByPlaceholder('Search docs')");
  assert.equal(chooseLocator(el({ tag: "div", name: "Only a name" }), plain), undefined);
});

test("quote escapes quotes, backslashes and collapses whitespace so the locator stays valid code", () => {
  assert.equal(quote("Don't \\ stop\n now"), "'Don\\'t \\\\ stop now'");
  const code = chooseLocator(el({ role: "button", name: "It's \"ok\"" }), plain)?.code ?? "";
  assert.doesNotThrow(() => new vm.Script(`(page) => ${code}`));
});

test("summarizeElements merges identical locators, flags ambiguity, limits and skips unidentifiable elements", () => {
  const remove = () => el({ role: "button", name: "Remove" });
  const summary = summarizeElements(
    [el({ role: "heading", name: "Title", tag: "h1" }), remove(), remove(), remove(), el({}), el({ role: "link", name: "Help", tag: "a", href: "/help" }), el({ role: "button", name: "Go", disabled: true })],
    plain,
    3,
  );
  assert.equal(summary.total, 4);
  assert.equal(summary.truncated, true);
  assert.equal(summary.ambiguousCount, 1);
  assert.equal(summary.elements.length, 3);
  assert.deepEqual(summary.elements[1], { tag: "button", role: "button", name: "Remove", locator: "page.getByRole('button', { name: 'Remove' })", source: "role", ambiguous: true, count: 3 });

  const all = summarizeElements([el({ role: "link", name: "Help", tag: "a", href: "/help" }), el({ role: "button", name: "Go", disabled: true, required: true })], plain, 10);
  assert.equal(all.elements[0].href, "/help");
  assert.equal(all.elements[1].disabled, true);
  assert.equal(all.elements[1].required, true);
});

test("origin policy requires BASE_URL and only allows its origins", () => {
  assert.throws(() => buildOriginPolicy(undefined, undefined), /BASE_URL is not set/);
  assert.throws(() => buildOriginPolicy("ftp://x.test", undefined), /http or https/);
  assert.throws(() => buildOriginPolicy("https://u:p@x.test", undefined), /credentials/);

  const policy = buildOriginPolicy("https://app.test/base/", "https://api.test", ["https://sso.test/login"]);
  assert.deepEqual(policy.allowedOrigins, ["https://app.test", "https://api.test", "https://sso.test"]);
  assert.equal(resolveInspectUrl("/login", policy), "https://app.test/login");
  assert.equal(resolveInspectUrl("https://sso.test/x?y=1", policy), "https://sso.test/x?y=1");
  assert.equal(resolveInspectUrl("rel/path", policy), "https://app.test/base/rel/path");

  for (const bad of ["https://evil.test/", "//evil.test/x", "http://app.test/", "https://app.test.evil.test/", "javascript:alert(1)", "file:///etc/passwd", "https://u:p@app.test/", "https://app.test/\nx"]) {
    assert.throws(() => resolveInspectUrl(bad, policy), /not allowed|http or https|credentials|invalid characters|not valid/, bad);
  }
});

test("secret placeholders are recognised and secret values are redacted from every string in the result", () => {
  assert.equal(usesSecretPlaceholder("{{TEST_USER}}"), true);
  assert.equal(usesSecretPlaceholder("{{TEST_USER}}"), true, "stateless across calls");
  assert.equal(usesSecretPlaceholder("{{OTHER}}"), false);

  const result = redactSecrets(
    { aria: '- textbox "Password": p"w\\1', locators: ["page.getByText('qa-user')"], nested: { title: "Hi qa-user" }, n: 1 },
    { TEST_USER: "qa-user", TEST_PASSWORD: 'p"w\\1', SHORT: "ab" },
  );
  assert.deepEqual(result, { aria: '- textbox "Password": {{redacted}}', locators: ["page.getByText('{{redacted}}')"], nested: { title: "Hi {{redacted}}" }, n: 1 });
  assert.deepEqual(redactSecrets({ a: "ab" }, { X: "ab" }), { a: "ab" }, "very short values are not redacted to avoid mangling output");
});

test("the browser-side child script is valid JavaScript and uses no template literals", () => {
  assert.doesNotThrow(() => new vm.Script(INSPECT_CHILD_SCRIPT, { filename: "inspect-child.js" }));
  assert.ok(!INSPECT_CHILD_SCRIPT.includes("`"));
  assert.match(INSPECT_CHILD_SCRIPT, /__PW_MCP_INSPECT__/);
});
