/**
 * Source of the script that `inspect_page` runs with `node -e` inside the QA project, so it uses that
 * project's own Playwright installation (the MCP never bundles Playwright). Input arrives as JSON in
 * PW_MCP_INSPECT_INPUT, optional credentials in PW_MCP_INSPECT_SECRETS. The result is printed as one line
 * prefixed with __PW_MCP_INSPECT__ (success) or __PW_MCP_INSPECT_ERROR__ (failure).
 *
 * It only reports raw facts about elements; locator selection happens in the MCP (selectors.ts).
 * The script is plain CommonJS without template literals so it can live in a TypeScript string.
 */
export const RESULT_MARKER = "__PW_MCP_INSPECT__";
export const ERROR_MARKER = "__PW_MCP_INSPECT_ERROR__";

export const INSPECT_CHILD_SCRIPT = `
const RESULT_MARKER = '${RESULT_MARKER}';
const ERROR_MARKER = '${ERROR_MARKER}';
const input = JSON.parse(process.env.PW_MCP_INSPECT_INPUT || '{}');
const secrets = JSON.parse(process.env.PW_MCP_INSPECT_SECRETS || '{}');

function firstLine(error) {
  return String(error && error.message ? error.message : error).split('\\n')[0].slice(0, 300);
}

function emit(marker, payload) {
  process.stdout.write('\\n' + marker + JSON.stringify(payload) + '\\n');
}

function fail(code, message) {
  emit(ERROR_MARKER, { code: code, message: message });
}

function loadPlaywright() {
  for (const name of ['@playwright/test', 'playwright', 'playwright-core']) {
    try {
      return require(name);
    } catch (error) {
      if (!(error && error.code === 'MODULE_NOT_FOUND')) throw error;
    }
  }
  return undefined;
}

function substitute(value) {
  return String(value).replace(/\\{\\{(TEST_USER|TEST_PASSWORD)\\}\\}/g, function (_, key) {
    if (!secrets[key]) throw new Error(key + ' is not set in .env');
    return secrets[key];
  });
}

// Runs inside the browser. Must not reference anything from the Node scope.
function extractElements(args) {
  var attrs = args.attrs;
  var max = args.max;
  var SELECTOR = ['a[href]', 'button', 'input', 'select', 'textarea', 'summary', '[role]', '[contenteditable]', 'h1', 'h2', 'h3', '[tabindex]']
    .concat(attrs.map(function (name) { return '[' + name + ']'; }))
    .join(',');
  var SKIP_ROLES = { presentation: 1, none: 1, generic: 1, group: 1 };
  var NAME_FROM_CONTENT = { button: 1, link: 1, heading: 1, menuitem: 1, tab: 1, option: 1, switch: 1, treeitem: 1, cell: 1, columnheader: 1, rowheader: 1, gridcell: 1, alert: 1, status: 1, dialog: 0 };

  function clean(text, limit) {
    return String(text || '').replace(/\\s+/g, ' ').trim().slice(0, limit);
  }
  function visible(el) {
    if (el.tagName === 'INPUT' && el.type === 'file') return true;
    var rect = el.getBoundingClientRect();
    var style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }
  function implicitRole(el, tag) {
    var type = (el.getAttribute('type') || 'text').toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'select') return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image') return 'button';
      if (type === 'checkbox' || type === 'radio') return type;
      if (type === 'range') return 'slider';
      if (type === 'number') return 'spinbutton';
      if (type === 'search') return 'searchbox';
      if (type === 'text' || type === 'email' || type === 'tel' || type === 'url') return 'textbox';
    }
    return undefined;
  }
  function labelText(el) {
    var parts = [];
    if (el.labels) {
      for (var i = 0; i < el.labels.length; i++) parts.push(el.labels[i].textContent);
    }
    return clean(parts.join(' '), 80);
  }
  function nameOf(el, tag, role) {
    var aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return clean(aria, 80);
    var by = el.getAttribute('aria-labelledby');
    if (by) {
      var text = by.split(/\\s+/).map(function (id) { var ref = document.getElementById(id); return ref ? ref.textContent : ''; }).join(' ');
      if (clean(text, 80)) return clean(text, 80);
    }
    if (tag === 'input' || tag === 'select' || tag === 'textarea') {
      var label = labelText(el);
      if (label) return label;
      var type = (el.getAttribute('type') || '').toLowerCase();
      if ((type === 'submit' || type === 'button' || type === 'reset') && el.value) return clean(el.value, 80);
      return clean(el.getAttribute('placeholder'), 80);
    }
    if (tag === 'img') return clean(el.getAttribute('alt'), 80);
    if (role && NAME_FROM_CONTENT[role]) return clean(el.innerText || el.textContent, 80);
    return clean(el.getAttribute('title'), 80);
  }

  var nodes = Array.prototype.slice.call(document.querySelectorAll(SELECTOR));
  var items = [];
  for (var index = 0; index < nodes.length && items.length < max; index++) {
    var el = nodes[index];
    var tag = el.tagName.toLowerCase();
    if (tag === 'input' && (el.getAttribute('type') || '').toLowerCase() === 'hidden') continue;
    if (!visible(el)) continue;
    var explicitRole = el.getAttribute('role');
    var role = explicitRole ? explicitRole.split(/\\s+/)[0] : implicitRole(el, tag);
    if (role && SKIP_ROLES[role]) role = undefined;

    var found = {};
    var hasAttr = false;
    for (var a = 0; a < attrs.length; a++) {
      var value = el.getAttribute(attrs[a]);
      if (value && value.trim()) {
        found[attrs[a]] = value.trim().slice(0, 120);
        hasAttr = true;
      }
    }
    var name = nameOf(el, tag, role);
    var label = tag === 'input' || tag === 'select' || tag === 'textarea' ? labelText(el) : '';
    var placeholder = clean(el.getAttribute('placeholder'), 80);
    var text = !role && !name ? clean(el.innerText || el.textContent, 60) : '';
    var formControl = tag === 'input' || tag === 'select' || tag === 'textarea';
    if (!hasAttr && !(role && name) && !(formControl && name) && !label && !placeholder && !text) continue;

    var item = { tag: tag, attrs: found };
    if (role) item.role = role;
    if (name) item.name = name;
    if (text) item.text = text;
    if (tag === 'input') item.type = (el.getAttribute('type') || 'text').toLowerCase();
    if (label) item.label = label;
    if (placeholder) item.placeholder = placeholder;
    if (tag === 'a') {
      var href = el.getAttribute('href');
      if (href) item.href = href.slice(0, 120);
    }
    if (el.disabled === true) item.disabled = true;
    if (el.required === true) item.required = true;
    if (el.checked === true) item.checked = true;
    items.push(item);
  }
  return { items: items, found: nodes.length, iframes: document.querySelectorAll('iframe').length };
}

async function settle(page) {
  await page.waitForLoadState('load', { timeout: 5000 }).catch(function () {});
  await page.waitForLoadState('networkidle', { timeout: 2500 }).catch(function () {});
}

async function snapshot(page, label, response) {
  var extracted = await page.evaluate(extractElements, { attrs: input.attributes, max: input.maxRaw });
  var aria;
  if (input.includeAria) {
    var body = page.locator('body');
    // ariaSnapshot() needs Playwright 1.49+; older versions simply return no snapshot.
    if (typeof body.ariaSnapshot === 'function') {
      aria = await body.ariaSnapshot({ timeout: 5000 }).catch(function () { return undefined; });
    }
    if (aria && aria.length > input.ariaMaxChars) aria = aria.slice(0, input.ariaMaxChars) + '\\n[truncated]';
  }
  return {
    label: label,
    url: page.url(),
    title: await page.title().catch(function () { return ''; }),
    httpStatus: response ? response.status() : undefined,
    raw: extracted.items,
    found: extracted.found,
    iframeCount: extracted.iframes,
    ariaSnapshot: aria,
  };
}

async function runStep(page, step) {
  switch (step.action) {
    case 'goto':
      return page.goto(step.url, { waitUntil: 'domcontentloaded', timeout: input.navTimeoutMs });
    case 'click':
      await page.locator(step.target).click();
      return undefined;
    case 'check':
      await page.locator(step.target).check();
      return undefined;
    case 'fill':
      await page.locator(step.target).fill(substitute(step.value));
      return undefined;
    case 'select':
      await page.locator(step.target).selectOption(substitute(step.value));
      return undefined;
    case 'press':
      await page.locator(step.target).press(step.key);
      return undefined;
    case 'waitFor':
      await page.locator(step.target).waitFor({ state: 'visible' });
      return undefined;
    default:
      return undefined;
  }
}

(async function main() {
  var playwright = loadPlaywright();
  if (!playwright) return fail('PLAYWRIGHT_NOT_INSTALLED', 'Playwright was not found in this project. Run npm install (the project needs @playwright/test).');
  var browserType = playwright[input.browser] || playwright.chromium;

  var browser;
  try {
    browser = await browserType.launch({ headless: true });
  } catch (error) {
    return fail('BROWSER_LAUNCH_FAILED', firstLine(error) + ' - install browsers with: npx playwright install ' + input.browser);
  }

  try {
    var context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      storageState: input.storageStatePath || undefined,
    });
    var allowed = new Set(input.allowedOrigins);
    var blocked = [];
    var blockedHits = 0;
    // Navigations (including redirects and iframes) may only reach allowed origins; sub-resources load normally.
    await context.route('**/*', function (route) {
      var request = route.request();
      if (request.isNavigationRequest()) {
        var origin = 'null';
        try { origin = new URL(request.url()).origin; } catch (error) { origin = 'null'; }
        if (!allowed.has(origin)) {
          blockedHits++;
          if (blocked.indexOf(origin) < 0) blocked.push(origin);
          return route.abort('blockedbyclient');
        }
      }
      return route.continue();
    });

    var page = await context.newPage();
    page.setDefaultTimeout(input.stepTimeoutMs);
    var states = [];
    var steps = [];

    var response;
    try {
      response = await page.goto(input.startUrl, { waitUntil: 'domcontentloaded', timeout: input.navTimeoutMs });
    } catch (error) {
      var reason = firstLine(error);
      return fail('NAVIGATION_FAILED', blocked.length > 0
        ? 'Navigation to ' + blocked.join(', ') + ' was blocked (origin not allowed). ' + reason
        : reason);
    }
    await settle(page);
    states.push(await snapshot(page, 'initial', response));

    var lastWasSnapshot = true;
    for (var index = 0; index < input.steps.length; index++) {
      var step = input.steps[index];
      if (step.action === 'snapshot') {
        states.push(await snapshot(page, step.label || 'step ' + (index + 1), undefined));
        steps.push({ index: index, action: step.action, ok: true });
        lastWasSnapshot = true;
        continue;
      }
      var blockedBefore = blockedHits;
      try {
        var stepResponse = await runStep(page, step);
        await settle(page);
        if (blockedHits > blockedBefore) {
          throw new Error('navigation to ' + blocked[blocked.length - 1] + ' was blocked: origin not allowed');
        }
        steps.push({ index: index, action: step.action, target: step.target || step.url, ok: true });
        lastWasSnapshot = false;
        if (stepResponse && step.action === 'goto') response = stepResponse;
      } catch (error) {
        steps.push({ index: index, action: step.action, target: step.target || step.url, ok: false, error: firstLine(error) });
        // A blocked navigation leaves Chrome on an error page; return to the page that was being inspected.
        if (page.url().indexOf('chrome-error:') === 0) await page.goBack({ timeout: 5000 }).catch(function () {});
        states.push(await snapshot(page, 'failed at step ' + (index + 1), undefined));
        lastWasSnapshot = true;
        break;
      }
    }
    if (!lastWasSnapshot) states.push(await snapshot(page, 'final', response));

    emit(RESULT_MARKER, { states: states, steps: steps, blockedOrigins: blocked });
  } catch (error) {
    fail('INSPECT_FAILED', firstLine(error));
  } finally {
    await browser.close().catch(function () {});
  }
})().catch(function (error) {
  fail('INSPECT_FAILED', firstLine(error));
});
`;
