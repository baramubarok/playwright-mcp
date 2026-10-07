# Changelog

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
