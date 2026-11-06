# Changelog

## 0.3.0 — QA-first approach

The MCP now targets QA teams: tests are generated from QA test cases and from the live website, in a separate automation repository. **Breaking:** the `playwright_write_test` prompt no longer tells the AI to read frontend source code, and `scaffold_test_domain` output changed (new shared support files, rich reference examples, 7 example tests instead of 2, `Payload`/`Record` types in `*.api.ts`, `setupState`/`cleanupState` replaced by `create`/`getById`/`list`/`update`/`remove`/`cleanup`).

### Added

- `init_qa_project`: scaffolds a standalone automation repo (`package.json`, `tsconfig.json`, `playwright.config.ts`, `.env` + `.env.example` with `BASE_URL`, `API_URL`, `ID_SELECTOR`, `TEST_USER`, `TEST_PASSWORD`, `.gitignore`, `docs/test-case/`, `assets/`, support helpers). Never overwrites `.env`.
- `read_test_cases`: reads Gherkin, CSV and (optionally, via the project's `exceljs`) Excel test cases from `docs/test-case/` into structured cases.
- `inspect_page`: scrapes the live site with the project's own Playwright (origin allowlist, `steps` for other UI states, `useAuth`, credential placeholders redacted from output) and returns the best locator per element: `data-testid` > `data-qa` > `data-{ID_SELECTOR}` > role+name > label > placeholder > text, with ambiguity flags.
- `scaffold_auth_setup`: global auth handler (login once through the form or the API, `storageState` in `.auth/user.json`, `setup` project wiring, `.auth/` git-ignored). `scaffold_test_domain` creates it automatically for auth-like features and starts their spec logged out (`withAuthSetup: false` opts out).
- `scaffold_test_domain`: `testTypes` and `apiBasePath` inputs, `helperCatalog` output, shared `support/selectors.ts` (`byTestId`, `byQa`, `byEnvId`) and `support/assets.ts` (`assetPath`).
- Reference examples in every scaffolded file, and smoke / ui / regression / integration example tests; the API fixture creates its own `API_URL` based context and deletes records created through `create()` after each test.
- `score_test_quality` anti-patterns: `inlineApiCall`, `inlineRoute`, `integrationWithoutApiHelper`, `unusedDomainHelpers` (also in the HTML quality report).
- Prompts `playwright_setup_qa_project` and `playwright_generate_from_testcase` (optional `ids` argument).
- `check_test_prerequisites` reports the QA layout (`qa`: `.env` key names, `docs/test-case/`, `assets/`); `check_playwright_config` reports `baseURL` / `testIdAttribute` and warns on a hardcoded `baseURL` or an unwired `ID_SELECTOR`.
- New error codes: `PLAYWRIGHT_NOT_INSTALLED`, `BROWSER_LAUNCH_FAILED`, `NAVIGATION_FAILED`, `INSPECT_TIMEOUT`, `INSPECT_FAILED`.
- Opt-in e2e tests: type-check of all scaffold output, `.xlsx` reading, `inspect_page` against a local page, and the generated reference tests running in Chromium.

### Changed

- Locator policy: stable data attributes first (`data-testid` > `data-qa` > `data-{ID_SELECTOR}`), semantic locators as the fallback. The scorer counts single `data-*` selectors and the selector helpers as stable locators.
- `playwright_write_test` is built around test cases and live-site inspection (no frontend source reading); `playwright_run_and_heal` re-inspects the live page before changing a locator.
- `scaffold_test_domain` templates moved to `src/templates/`.

## Unreleased (v0.2 fixing)

### Removed

- `read_file`, `list_files` and `write_test_file` tools, and the `playwright_e2e_workflow` prompt. MCP clients provide file access natively; scaffolding is done by `scaffold_test_domain`, and the workflow guide is split into `playwright_write_test` and `playwright_run_and_heal`. There is no compatibility shim (decision S6-05).
- Unused `fast-glob` and `diff` dependencies (they were only used by the removed tools).

### Added

- `check_test_prerequisites`: read-only preflight for Playwright/CLI/config/browsers/Allure, including workspace-hoisted packages and browser build/version matching.
- `scaffold_test_domain` with input validation, root containment and symlink checks; generated specs are explicit `test.fixme` skeletons with an `@mcp-skeleton` marker, plus a shared `support/diagnostics.fixture.ts`.
- Real browser diagnostics (console errors/warnings, page errors, failed requests, HTTP ≥ 400) from `trace.zip` and/or the diagnostics fixture; recent steps from the trace; `errorContextPath`.
- Project reporters are preserved during MCP runs through a temporary wrapper config; `nativeReports` locates their output.
- MCP `outputSchema` + `structuredContent` for every tool and a stable error contract `{ code, message, details }`.
- `detail: "summary" | "full"` for `run_playwright_test`, with documented size caps.
- MCP request cancellation for `run_playwright_test` and Allure generation; runner process groups are killed when the server exits.
- AST-based `check_playwright_config` (literal / expression / missing, reporters, `projects[].use`, limitations).

### Changed

- `run_playwright_test` classifies exit code, signal, timeout, cancellation, report errors, missing/malformed reports and empty suites; it never reports `passed` for an infrastructure failure. Tests have stable ids (`specId:projectId`) and `projectName`.
- Error messages are stripped of ANSI escape codes; error categories check network, locator and assertion signals before the generic timeout.
- `score_test_quality` uses the TypeScript AST: comments, strings and template text are no longer counted, and only floating (un-awaited) actions are flagged.
- `generate_test_report` returns `mode` and `status`; Allure is generated with the local CLI (no `npx`), with a timeout and exit-code/stderr checks.
- Test-process stderr is no longer reported as browser console output.
- Runner report directories are retained for the last 20 runs and cleaned up on exit; reports above 50 MB are rejected.
- `npm run build` cleans `dist/` first, so removed modules are not published.
