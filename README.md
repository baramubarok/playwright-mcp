# playwright-generate-mcp

An enterprise-grade Model Context Protocol (MCP) server that empowers AI coding assistants (Cursor, Claude Desktop, Antigravity, Roo Code, etc.) to generate, score, run, and auto-heal **robust, maintainable, and flake-resistant Playwright E2E tests**.

It is built for **QA teams**: tests are generated from the QA **test cases** (Gherkin, CSV, Excel) and from what the **live website** really renders, never from frontend source code. It lives in its own automation repository, enforces a **Domain-Driven Page Object Model (POM)** architecture, provides **cross-file quality scoring**, extracts **rich single-turn failure diagnostics**, and adheres to strict **web-first anti-flakiness rules**.

---

## 🧪 QA-first workflow

1. **Set up a separate automation repo** — ask the AI to run the `playwright_setup_qa_project` prompt, or call `init_qa_project` with the target folder, `BASE_URL`, `API_URL` and (optionally) `ID_SELECTOR`. It creates `package.json`, `playwright.config.ts`, `.env` / `.env.example`, `.gitignore`, `docs/test-case/` and `assets/`. To work in an existing automation repo instead, just open it (or call `set_project_root`); `check_test_prerequisites` reports what is missing.
2. **Fill `.env`** — `TEST_USER` / `TEST_PASSWORD` are typed by you and never leave the file (it is git-ignored):

   ```dotenv
   BASE_URL=https://staging.your-app.com
   API_URL=https://api.staging.your-app.com
   ID_SELECTOR=qa          # data-qa; becomes use.testIdAttribute = "data-qa"
   TEST_USER=
   TEST_PASSWORD=
   ```

3. **Install**: `npm install` and `npx playwright install chromium` in the automation repo (the MCP never installs anything).
4. **Put test cases in `docs/test-case/`** (`.feature`, `.csv`, optional `.xlsx`) and files used by upload steps in `assets/`. See the README created in `docs/test-case/` for the CSV columns.
5. **Generate** — run the `playwright_generate_from_testcase` prompt (optionally with `ids`, e.g. `TC-001, TC-002`). The AI reads the test cases (`read_test_cases`), scrapes every page of the live site (`inspect_page`), scaffolds the domain (`scaffold_test_domain`), implements **one test per test case** (`[TC-001] …` title + `@TC-001` tag), then scores and runs it.

**Selector priority** when scraping and generating: `data-testid` > `data-qa` > `data-{ID_SELECTOR}` > semantic (`getByRole` > `getByLabel` / `getByPlaceholder` > `getByText`). `ID_SELECTOR` is wired into `use.testIdAttribute`, so `page.getByTestId()` reads your team's attribute; the other attributes use `byTestId()` / `byQa()` / `byEnvId()` from `tests/e2e/support/selectors.ts`.

**Global auth** — for login/logout/register features (or via `scaffold_auth_setup`) the MCP creates `tests/e2e/auth/`: a setup project logs in once with `TEST_USER` / `TEST_PASSWORD` (through the login form, or the backend API) and saves the session to the git-ignored `.auth/user.json`; every other test and `inspect_page` (`useAuth: true`) reuses it. Login specs start logged out.

---

## ✨ Key Features

- 🌐 **Live-site scraping instead of source code**: `inspect_page` opens the application under test with the project's own Playwright and returns role, accessible name and the best locator per element, reaching modals and wizard steps through `steps`. Navigation is restricted to `BASE_URL` / `API_URL` origins and credentials are redacted from the output.
- 📝 **Test-case driven**: `read_test_cases` parses Gherkin, CSV and Excel files into structured cases (id, steps, expected results, priority) so every generated test is traceable to its test case.
- 🏗️ **Domain-Driven POM Architecture**: Enforces separation of concerns between Declarative Specs, Page Objects, Custom Fixtures, and Dynamic Data Factories. Every scaffolded file contains **working reference examples**, and the spec shows the four test styles (`@smoke`, `@ui`, `@regression`, `@integration`) so generated tests stay consistent.
- 🔌 **One source for every handler**: specs must use the fixture's `*Api` / `*Mock` helpers; `score_test_quality` flags `request.*` / `fetch` / `page.route()` written inline in a spec (`inlineApiCall`, `inlineRoute`), `@integration` tests without an `*Api` fixture, and unused helpers.
- 🔍 **Cross-File POM Quality Scoring**: `score_test_quality` and `run_playwright_test` automatically traverse import dependencies (`.spec.ts` $\rightarrow$ `.fixture.ts` $\rightarrow$ `*.page.ts` / `*.component.ts`), scoring locators and anti-patterns across all related files.
- ⚡ **Single-Turn Rich Diagnostics**: When a test fails, `run_playwright_test` immediately returns the exact file & line location, error category, the last steps before failure, and — from real browser events in the trace and/or the scaffolded diagnostics fixture — console errors, page errors and failed requests (network errors and HTTP 4xx/5xx), plus screenshot/trace/video/error-context paths.
- 📦 **Bounded, typed MCP output**: every tool declares an `outputSchema` and returns `structuredContent`; the default run summary has a hard size cap (see [Output contract](#-output-contract--token-budget)).
- 🛡️ **Strict Anti-Flakiness Rules**: Detects and discourages arbitrary sleeps (`waitForTimeout`, `setTimeout`), un-awaited actions, `networkidle` dependencies, and manual text extractions in favor of web-first auto-retrying assertions.
- 🏷️ **Multi-File & Tag-Only Test Execution**: `run_playwright_test` supports running a single spec, an entire directory of specs, or tag-only runs (e.g. `grep: "@smoke"` or `grep: "@regression"`) across the test suite without requiring a specific spec file.
- 💻 **Cross-Platform & Windows Ready**: Safe process lifecycle management across Linux, macOS, and Windows (tree-kill via `taskkill /T /F` on Windows, POSIX process groups on Unix, `.cmd`/`.bat` shell execution, and `windowsHide` console suppression).
- 🧭 **Stateless Root Auto-Discovery**: Automatically traverses parent directories to discover `playwright.config.{ts,js,mjs,cjs,mts,cts}` without requiring manual path configuration.
- 💬 **Adaptive Interactive Confirmations**: Supports interactive UI modals (`ask_question`, `vscode_askQuestions`) or formatted numbered lists before applying test heals.

---

## 📁 Architecture Standard

This MCP guides AI agents to structure tests under a clean Domain-Driven hierarchy:

```
tests/e2e/
├── support/
│   ├── diagnostics.fixture.ts   # Shared auto fixture recording browser console/page/network events
│   ├── selectors.ts             # byTestId / byQa / byEnvId helpers for data-* attributes
│   └── assets.ts                # assetPath(): files for upload steps, restricted to assets/
├── auth/                        # Global auth handler (scaffold_auth_setup)
│   ├── auth.setup.ts            # Logs in once, saves .auth/user.json
│   ├── auth.page.ts | auth.api.ts
│   └── auth.config.ts
├── domain/                      # Grouped by business features
│   └── {feature}/
│       ├── pages/               # Page Objects / Component Objects
│       │   └── {step}.page.ts
│       ├── {feature}.mock.ts    # page.route() handlers for @ui tests (success, empty, 422, 500, pending, request capture)
│       ├── {feature}.api.ts     # Real API helpers for @integration tests (CRUD, tracked cleanup)
│       └── {feature}.fixture.ts # Custom Fixture injecting Page Objects, mocks and APIs (API fixture auto-cleans)
├── factory/                     # Dynamic test data builders
│   └── {entity}.factory.ts      # Unique data per run and per worker
└── specs/                       # Declarative, readable test specs
    └── {feature}.spec.ts
```

`scaffold_test_domain` generates an **explicit skeleton**: the spec's tests are `test.fixme(...)` (Playwright skips them) and the file carries an `// @mcp-skeleton` marker. `score_test_quality` reports `scaffold.skeleton: true` until the examples are adapted, `test.fixme` is changed to `test` and the marker is removed — so an empty scaffold can never look like a passing test. Generated files compile under `strict` TypeScript and the reference examples are exercised in a real browser by the opt-in e2e suite. The shared `support/` files are created once and are never overwritten, even with `overwrite: true`. The tool also returns a `helperCatalog` (fixtures with their locators and methods) so the AI does not need to re-read the files.

### Core Design Rules
1. **Strict Separation**: No raw locators, `request.*` or `page.route()` inside `*.spec.ts` files. UI interactions live in Page Objects, mocks in `*.mock.ts`, real API calls in `*.api.ts`; a missing endpoint means a new method there.
2. **Custom Fixtures**: Inject Page Objects and test data using `test.extend<Fixtures>()` instead of manual `new Page()` instantiations in specs.
3. **Dynamic Data Factories**: Generate unique test data per run to prevent database unique-constraint collisions on test re-runs.
4. **Stable Locators**: Prioritize `data-testid` > `data-qa` > `data-{ID_SELECTOR}`, then `getByRole` > `getByLabel` / `getByPlaceholder` > `getByText`. Deep nested CSS (`div > div > span`) is strictly forbidden.
5. **Tagging Conventions**:
   - `@smoke`: Critical happy paths.
   - `@regression`: Comprehensive user flows.
   - `@ui`: Pure UI/frontend tests using `page.route()` to stub API responses.
   - `@integration`: Tests validating against real backend APIs.

### Test prerequisite preflight

Use `check_test_prerequisites` before `run_playwright_test` when setting up a target project. The check is read-only: it inspects the target project's `package.json`, locally resolvable Playwright packages and CLI, supported config files, browser cache, optional Allure adapter/CLI, and existing report artifacts. It does not run `npm install`, download browsers, or generate reports. Follow the returned `nextSteps` manually, then run the preflight again.

- **Monorepos**: Playwright hoisted to a workspace root (npm/yarn `workspaces`, `pnpm-workspace.yaml`, `lerna.json`) is accepted and reported as `resolvedFrom: "workspace"`. A package found in an unrelated parent directory is not.
- **Browsers**: installed builds are compared with the builds the installed Playwright expects (`playwright-core/browsers.json`); a mismatch is `outdated`. Incomplete downloads are ignored. Configs that use a branded `channel` (`chrome`, `msedge`) do not require the Playwright browser cache.

### Reporters and browser diagnostics

`run_playwright_test` needs a JSON report, but `--reporter=json` would replace the project's own reporters. When the project has a `playwright.config.*`, the runner writes a temporary `.pw-mcp-*.config.ts` next to it that imports the project config unchanged and appends a JSON reporter, so HTML/Allure reporters keep working (`runner.reporterStrategy: "config_wrapper"`, `runner.preservedReporters`, `nativeReports`). When Allure is configured and its local CLI is present, `run_playwright_test` automatically compiles the Allure report (`allure-report/index.html`) upon completion (reported in `nativeReports.allureReportPath`) without spawning blocking servers. The wrapper is deleted after every run, including timeouts and cancellations. Without a config file the runner falls back to `--reporter=json` (`cli_override`). `check_test_prerequisites` provides `allure.autoGenerateReady` and an actionable `allure.setupGuide` for first-time project onboarding. The HTML/Allure reporters are never opened with blocking commands automatically during MCP runs.

Browser diagnostics come only from real browser events:

| Source | When available | What it provides |
| :--- | :--- | :--- |
| `trace` | `use.trace` keeps a trace for the failing attempt (`retain-on-failure`, `on-first-retry`, `on`) | console errors/warnings, page errors, failed requests and HTTP ≥ 400 responses, recent steps |
| `fixture` | the test imports the scaffolded `support/diagnostics.fixture.ts` | the same events recorded with `page.on(...)`, attached as `mcp-diagnostics` on failure |

`failures[].diagnosticsSources` names the sources used; when it is absent, no browser diagnostics were available (they are never inferred from test-process stderr). Network errors quoted in the error message itself (e.g. `net::ERR_CONNECTION_REFUSED`) are kept with `source: "error_message"`. Event counts and message lengths are bounded.

---

## 🛠️ MCP Tools

| Tool | Description |
| :--- | :--- |
| **`init_qa_project`** | Creates a standalone QA automation repo: `package.json`, `tsconfig.json`, `playwright.config.ts` (reads `.env`, fails fast without `BASE_URL`, wires `ID_SELECTOR` into `use.testIdAttribute`), `.env` (0600) and `.env.example` (`BASE_URL`, `API_URL`, `ID_SELECTOR`, `TEST_USER`, `TEST_PASSWORD`), `.gitignore`, `docs/test-case/` (README + examples), `assets/` and the `tests/e2e/support` helpers. Existing files are skipped (`overwrite` never touches `.env`) and the new repo becomes the active project root. |
| **`read_test_cases`** | Reads `docs/test-case/` (Gherkin `.feature`, `.csv`, optional `.xlsx` via the project's `exceljs`) into structured cases: `id`, `title`, `feature`, `priority`, `tags`, `preconditions`, `steps`, `expected`, source file and line/row. Read-only, limited to that folder (symlinks are not followed), filterable by `ids` / `path`, with duplicate-ID and malformed-row warnings. |
| **`inspect_page`** | Opens a page of the live app (`BASE_URL` origin, plus `API_URL` and explicit `allowedOrigins`) in headless Chromium/Firefox/WebKit using the project's own Playwright and returns the visible elements with role, accessible name and the best locator (`data-testid` > `data-qa` > `data-{ID_SELECTOR}` > role+name > label > placeholder > text), an optional ARIA snapshot, and hints (ambiguous locators, iframes, helper imports). `steps` (`click`, `fill`, `select`, `press`, `check`, `waitFor`, `snapshot`, `goto`) capture other UI states; `useAuth` reuses `.auth/user.json`; `{{TEST_USER}}` / `{{TEST_PASSWORD}}` are redacted from the output. |
| **`scaffold_auth_setup`** | Creates the global auth handler under `tests/e2e/auth` (UI login form or backend API login), a `setup` project with `storageState` + `dependencies` in `playwright.config.*` (only patched when it is the standard QA config, otherwise a snippet is returned) and git-ignores `.auth/`. `scaffold_test_domain` calls it automatically for auth-like features. |
| **`scaffold_test_domain`** | Scaffolds the 6-file Domain-Driven POM structure for a feature (`pages/*.page.ts`, `{feature}.mock.ts`, `{feature}.api.ts`, `{feature}.fixture.ts`, `factory/{feature}.factory.ts`, `specs/{feature}.spec.ts`) plus shared support helpers. Every file has working reference examples and the spec has smoke, ui, regression and integration examples (`testTypes` selects them, `apiBasePath` sets the API path). Returns a `helperCatalog`. Auth-like features start logged out. The spec is an explicit `test.fixme` skeleton. |
| **`run_playwright_test`** | Runs Playwright tests (a single spec file, a directory, or tag-only with `grep` like `@smoke`/`@regression`) with the local Playwright CLI (never `npx`), a validated timeout (default 120 s, 100 ms–900 s) and MCP request cancellation. Returns an explicit status (`passed`, `failed`, `timedout`, `interrupted`, `flaky`, `skipped`, `runner_error`, `setup_required`), counts, runner metadata, stable test IDs (`specId:projectId`) with project names, bounded failure diagnostics and a compact quality score. `detail: "full"` adds every test with retry attempts and runner stdout/stderr. |
| **`score_test_quality`** | Scores a spec file, page object, or test directory and its imported Page Objects with the TypeScript AST (comments and strings are ignored): `% stable/semantic locators` (data attributes and `byTestId`/`byQa`/`byEnvId` count as stable), assertion density, anti-patterns (`waitForTimeout`, missing `await`, index locators, nested CSS/XPath, manual text extraction, `inlineApiCall`, `inlineRoute`, `integrationWithoutApiHelper`, `unusedDomainHelpers`) with line numbers, and scaffold skeleton status. |
| **`get_failure_details`** | Full, bounded diagnostics for one failing test from a previous run report: location, recent steps, call log, browser console/page/network diagnostics, screenshot/trace/video/error-context paths. Pass `testId` when titles repeat (e.g. one spec in several projects). |
| **`generate_test_report`** | `quality` and `html` **locate** existing reports (the quality dashboard; the Playwright HTML report written by the project's html reporter). `allure` **generates** `allure-report/` with the local Allure CLI (never downloaded), with a timeout and exit-code/stderr checks. Returns `status`: `located`, `generated`, `not_found`, `setup_required` or `generation_failed`. |
| **`check_playwright_config`** | Statically analyzes `playwright.config.*` (TypeScript AST, never executed) for `retries`, `workers`, `trace`, `screenshot`, `video`, `forbidOnly`, `fullyParallel`, `baseURL`, `testIdAttribute` and reporters (HTML/JSON/Allure). Each value is reported as `literal`, `expression` (computed at runtime, not evaluated) or `missing`; spreads, imports and helper functions are listed under `limitations`. Warns about a hardcoded `baseURL` and about an `ID_SELECTOR` in `.env` that is not wired to `testIdAttribute`. |
| **`check_test_prerequisites`** | Read-only setup check for the local or workspace-hoisted Playwright package/CLI, config, browser builds, branded channels, optional Allure adapter/CLI and the QA layout (`.env` keys — names only, never values — `docs/test-case/`, `assets/`). It never installs packages or downloads browsers. |
| **`set_project_root`** | Runtime fallback to manually set the target project root if auto-detection is not applicable. |

---

## 📋 MCP Prompts

* **`playwright_setup_qa_project`**: Onboarding for QA: collects path, `BASE_URL`, `API_URL`, `ID_SELECTOR`, creates the automation repo with `init_qa_project` and the global auth handler. It never asks for passwords in chat.
* **`playwright_generate_from_testcase`** (optional argument `ids`): The main QA workflow — `read_test_cases` → `inspect_page` on the live site → `scaffold_test_domain` → one test per test case (`[TC-001]` title + `@TC-001` tag) → `score_test_quality` → `run_playwright_test`.
* **`playwright_write_test`**: Authoring rules and structure: scaffolding, stable locators, one source for every mock/api handler, global auth, secrets from `.env`, tagging. Contains no instruction to read frontend source.
* **`playwright_run_and_heal`**: Focused prompt guiding AI agents to run tests, inspect single-turn failure diagnostics and video recordings, re-inspect the live page with `inspect_page`, and perform safe, targeted healing in Page Objects.

---

## 📐 Output contract & token budget

- Every tool declares an MCP `outputSchema` and returns `structuredContent`. The text content repeats it as a one-line summary followed by compact JSON, for clients that only forward text.
- Errors are returned with `isError: true` and `structuredContent: { error: { code, message, details? } }`. Codes are stable: `INVALID_PATH`, `INVALID_IDENTIFIER`, `INVALID_INPUT`, `NOT_FOUND`, `PROJECT_ROOT_NOT_FOUND`, `REPORT_ACCESS_DENIED`, `REPORT_NOT_FOUND`, `REPORT_TOO_LARGE`, `REPORT_MALFORMED`, `AMBIGUOUS_TEST`, `TEST_NOT_FOUND`, `TEST_NOT_FAILED`, `PLAYWRIGHT_NOT_INSTALLED`, `BROWSER_LAUNCH_FAILED`, `NAVIGATION_FAILED`, `INSPECT_TIMEOUT`, `INSPECT_FAILED`, `INTERNAL_ERROR`.
- `run_playwright_test` (`detail: "summary"`, the default) is capped at **6,000 characters of JSON** (≈ 1,500 tokens) for any suite size; a typical failing run is ≈ 3,500 characters (≈ 900 tokens). It lists up to 5 failures and 20 non-passing tests, a 1,000-character stderr tail, and paths relative to `projectRoot`. When the cap is reached, the least important detail is dropped first and `outputBudget.reduced` is `true`.
- `detail: "full"` is capped at 100,000 characters. `get_failure_details` returns one failure with error messages up to 4,000 characters and absolute paths.
- JSON reports above 50 MB are rejected. The last 20 runner reports are kept for `get_failure_details`; older ones are deleted, and all are removed when the server exits.

---

## 🚀 Installation & Setup

### 1. Build from Source

```bash
git clone https://github.com/your-username/playwright-generate-mcp.git
cd playwright-generate-mcp
npm install
npm run build
```

### 2. Configure MCP Client

Add the server to your MCP configuration file (e.g. `claude_desktop_config.json`, Cursor Settings, or Antigravity MCP settings):

```json
{
  "mcpServers": {
    "playwright-generate": {
      "command": "node",
      "args": ["/absolute/path/to/playwright-generate-mcp/dist/index.js"]
    }
  }
}
```

Or when published to NPM:

```json
{
  "mcpServers": {
    "playwright-generate": {
      "command": "npx",
      "args": ["-y", "playwright-generate-mcp"]
    }
  }
}
```

---

## 🧑‍💻 Development

```bash
npm run dev               # tsx watch mode
npm run build             # Clean dist/ and compile TypeScript
npm start                 # Run compiled MCP server
npm test                  # Build, then run unit + integration tests (deterministic, no network)
npm run test:unit
npm run test:integration
npm run test:e2e          # Opt-in: real Playwright, see below
npm run check:package     # package.json / package-lock.json consistency
```

The end-to-end suite runs only when `PW_MCP_REAL_PLAYWRIGHT_WORKSPACE` points to a directory whose `package.json` declares `workspaces` and that has `@playwright/test`, `typescript`, `@types/node`, `dotenv`, `exceljs` and a browser installed. It covers the real runner, the type-check of everything the scaffold tools generate, `.xlsx` reading, `inspect_page` against a local page, and the generated reference tests running end to end in Chromium (no internet needed):

```bash
mkdir ~/pw-lab && cd ~/pw-lab
echo '{"private":true,"workspaces":["*"]}' > package.json
npm i -D @playwright/test typescript @types/node dotenv exceljs && npx playwright install chromium
PW_MCP_REAL_PLAYWRIGHT_WORKSPACE=~/pw-lab npm run test:e2e
```

Set `PW_MCP_KEEP=1` to keep the temporary project of the end-to-end workflow test for debugging.

---

## 📄 License

MIT — see [LICENSE](LICENSE).
