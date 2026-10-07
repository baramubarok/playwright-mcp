# playwright-generate-mcp

An enterprise-grade Model Context Protocol (MCP) server that empowers AI coding assistants (Cursor, Claude Desktop, Antigravity, Roo Code, etc.) to generate, score, run, and auto-heal **robust, maintainable, and flake-resistant Playwright E2E tests**.

It enforces a **Domain-Driven Page Object Model (POM)** architecture, provides **cross-file quality scoring**, extracts **rich single-turn failure diagnostics**, and adheres to strict **web-first anti-flakiness rules**.

---

## ✨ Key Features

- 🏗️ **Domain-Driven POM Architecture**: Enforces separation of concerns between Declarative Specs, Page Objects, Custom Fixtures, and Dynamic Data Factories.
- 🔍 **Cross-File POM Quality Scoring**: `score_test_quality` and `run_playwright_test` automatically traverse import dependencies (`.spec.ts` $\rightarrow$ `.fixture.ts` $\rightarrow$ `*.page.ts` / `*.component.ts`), scoring locators and anti-patterns across all related files.
- ⚡ **Single-Turn Rich Diagnostics**: When a test fails, `run_playwright_test` immediately returns the exact file & line location, error category, the last steps before failure, and — from real browser events in the trace and/or the scaffolded diagnostics fixture — console errors, page errors and failed requests (network errors and HTTP 4xx/5xx), plus screenshot/trace/video/error-context paths.
- 📦 **Bounded, typed MCP output**: every tool declares an `outputSchema` and returns `structuredContent`; the default run summary has a hard size cap (see [Output contract](#-output-contract--token-budget)).
- 🛡️ **Strict Anti-Flakiness Rules**: Detects and discourages arbitrary sleeps (`waitForTimeout`, `setTimeout`), un-awaited actions, `networkidle` dependencies, and manual text extractions in favor of web-first auto-retrying assertions.
- 🧭 **Stateless Root Auto-Discovery**: Automatically traverses parent directories to discover `playwright.config.{ts,js,mjs,cjs,mts,cts}` without requiring manual path configuration.
- 💬 **Adaptive Interactive Confirmations**: Supports interactive UI modals (`ask_question`, `vscode_askQuestions`) or formatted numbered lists before applying test heals.

---

## 📁 Architecture Standard

This MCP guides AI agents to structure tests under a clean Domain-Driven hierarchy:

```
tests/e2e/
├── support/
│   └── diagnostics.fixture.ts   # Shared auto fixture recording browser console/page/network events
├── domain/                      # Grouped by business features
│   └── {feature}/
│       ├── pages/               # Page Objects / Component Objects
│       │   └── {step}.page.ts
│       ├── {feature}.mock.ts    # page.route() handlers for @ui tests
│       ├── {feature}.api.ts     # Real API helpers for @integration tests
│       └── {feature}.fixture.ts # Custom Fixture injecting Page Objects, mocks and APIs
├── factory/                     # Dynamic test data builders
│   └── {entity}.factory.ts      # Unique data per run and per worker
└── specs/                       # Declarative, readable test specs
    └── {feature}.spec.ts
```

`scaffold_test_domain` generates an **explicit skeleton**: the spec's tests are `test.fixme(...)` (Playwright skips them) and the file carries an `// @mcp-skeleton` marker. `score_test_quality` reports `scaffold.skeleton: true` until the TODOs are implemented, `test.fixme` is changed to `test` and the marker is removed — so an empty scaffold can never look like a passing test. Generated files compile under `strict` TypeScript. The shared `support/diagnostics.fixture.ts` is created once and is never overwritten, even with `overwrite: true`.

### Core Design Rules
1. **Strict Separation**: No raw locators or direct DOM manipulations inside `*.spec.ts` files. All UI interactions live inside Page/Component Objects.
2. **Custom Fixtures**: Inject Page Objects and test data using `test.extend<Fixtures>()` instead of manual `new Page()` instantiations in specs.
3. **Dynamic Data Factories**: Generate unique test data per run to prevent database unique-constraint collisions on test re-runs.
4. **Semantic Locators**: Prioritize `getByRole` > `getByLabel` / `getByPlaceholder` > `getByText` > `getByTestId`. Deep nested CSS (`div > div > span`) is strictly forbidden.
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

`run_playwright_test` needs a JSON report, but `--reporter=json` would replace the project's own reporters. When the project has a `playwright.config.*`, the runner writes a temporary `.pw-mcp-*.config.ts` next to it that imports the project config unchanged and appends a JSON reporter, so HTML/Allure reporters keep working (`runner.reporterStrategy: "config_wrapper"`, `runner.preservedReporters`, `nativeReports`). The wrapper is deleted after every run, including timeouts and cancellations. Without a config file the runner falls back to `--reporter=json` (`cli_override`). The HTML reporter is never opened automatically during MCP runs.

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
| **`scaffold_test_domain`** | Scaffolds the 6-file Domain-Driven POM structure for a feature (`pages/*.page.ts`, `{feature}.mock.ts`, `{feature}.api.ts`, `{feature}.fixture.ts`, `factory/{feature}.factory.ts`, `specs/{feature}.spec.ts`) plus the shared diagnostics fixture. The spec is an explicit `test.fixme` skeleton. Always use this before writing new tests. |
| **`run_playwright_test`** | Runs a spec with the local Playwright CLI (never `npx`), a validated timeout (default 120 s, 100 ms–900 s) and MCP request cancellation. Returns an explicit status (`passed`, `failed`, `timedout`, `interrupted`, `flaky`, `skipped`, `runner_error`, `setup_required`), counts, runner metadata, stable test IDs (`specId:projectId`) with project names, bounded failure diagnostics and a compact quality score. `detail: "full"` adds every test with retry attempts and runner stdout/stderr. |
| **`score_test_quality`** | Scores a spec file and its imported Page Objects with the TypeScript AST (comments and strings are ignored): `% semantic locators`, assertion density, anti-patterns (`waitForTimeout`, missing `await`, index locators, nested CSS/XPath, manual text extraction) with line numbers, and scaffold skeleton status. |
| **`get_failure_details`** | Full, bounded diagnostics for one failing test from a previous run report: location, recent steps, call log, browser console/page/network diagnostics, screenshot/trace/video/error-context paths. Pass `testId` when titles repeat (e.g. one spec in several projects). |
| **`generate_test_report`** | `quality` and `html` **locate** existing reports (the quality dashboard; the Playwright HTML report written by the project's html reporter). `allure` **generates** `allure-report/` with the local Allure CLI (never downloaded), with a timeout and exit-code/stderr checks. Returns `status`: `located`, `generated`, `not_found`, `setup_required` or `generation_failed`. |
| **`check_playwright_config`** | Statically analyzes `playwright.config.*` (TypeScript AST, never executed) for `retries`, `workers`, `trace`, `screenshot`, `video`, `forbidOnly`, `fullyParallel` and reporters (HTML/JSON/Allure). Each value is reported as `literal`, `expression` (computed at runtime, not evaluated) or `missing`; spreads, imports and helper functions are listed under `limitations`. |
| **`check_test_prerequisites`** | Read-only setup check for the local or workspace-hoisted Playwright package/CLI, config, browser builds, branded channels and optional Allure adapter/CLI. It never installs packages or downloads browsers. |
| **`set_project_root`** | Runtime fallback to manually set the target project root if auto-detection is not applicable. |

---

## 📋 MCP Prompts

* **`playwright_write_test`**: Focused prompt guiding AI agents to scaffold domain files with `scaffold_test_domain`, fill semantic locators, setup mock/api handlers, dynamic factories, and clean specs.
* **`playwright_run_and_heal`**: Focused prompt guiding AI agents to run tests, inspect single-turn failure diagnostics and video recordings, and perform safe, targeted healing in Page Objects.

---

## 📐 Output contract & token budget

- Every tool declares an MCP `outputSchema` and returns `structuredContent`. The text content repeats it as a one-line summary followed by compact JSON, for clients that only forward text.
- Errors are returned with `isError: true` and `structuredContent: { error: { code, message, details? } }`. Codes are stable: `INVALID_PATH`, `INVALID_IDENTIFIER`, `INVALID_INPUT`, `NOT_FOUND`, `PROJECT_ROOT_NOT_FOUND`, `REPORT_ACCESS_DENIED`, `REPORT_NOT_FOUND`, `REPORT_TOO_LARGE`, `REPORT_MALFORMED`, `AMBIGUOUS_TEST`, `TEST_NOT_FOUND`, `TEST_NOT_FAILED`, `INTERNAL_ERROR`.
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

The end-to-end suite runs only when `PW_MCP_REAL_PLAYWRIGHT_WORKSPACE` points to a directory whose `package.json` declares `workspaces` and that has `@playwright/test` and its browsers installed:

```bash
mkdir ~/pw-lab && cd ~/pw-lab
echo '{"private":true,"workspaces":["*"]}' > package.json
npm i -D @playwright/test && npx playwright install chromium
PW_MCP_REAL_PLAYWRIGHT_WORKSPACE=~/pw-lab npm run test:e2e
```

---

## 📄 License

MIT — see [LICENSE](LICENSE).
