# playwright-generate-mcp

An enterprise-grade Model Context Protocol (MCP) server that empowers AI coding assistants (Cursor, Claude Desktop, Antigravity, Roo Code, etc.) to generate, score, run, and auto-heal **robust, maintainable, and flake-resistant Playwright E2E tests**.

It enforces a **Domain-Driven Page Object Model (POM)** architecture, provides **cross-file quality scoring**, extracts **rich single-turn failure diagnostics**, and adheres to strict **web-first anti-flakiness rules**.

---

## ✨ Key Features

- 🏗️ **Domain-Driven POM Architecture**: Enforces separation of concerns between Declarative Specs, Page Objects, Custom Fixtures, and Dynamic Data Factories.
- 🔍 **Cross-File POM Quality Scoring**: `score_test_quality` and `run_playwright_test` automatically traverse import dependencies (`.spec.ts` $\rightarrow$ `.fixture.ts` $\rightarrow$ `*.page.ts` / `*.component.ts`), scoring locators and anti-patterns across all related files.
- ⚡ **Single-Turn Rich Diagnostics**: When a test fails, `run_playwright_test` immediately returns the exact file & line location, error category, the last 3–5 action steps before failure, browser console logs, failed HTTP requests (4xx/5xx), and screenshot paths in a single turn.
- 🛡️ **Strict Anti-Flakiness Rules**: Detects and discourages arbitrary sleeps (`waitForTimeout`, `setTimeout`), un-awaited actions, `networkidle` dependencies, and manual text extractions in favor of web-first auto-retrying assertions.
- 🧭 **Stateless Root Auto-Discovery**: Automatically traverses parent directories to discover `playwright.config.{ts,js,mjs,cjs,mts,cts}` without requiring manual path configuration.
- 💬 **Adaptive Interactive Confirmations**: Supports interactive UI modals (`ask_question`, `vscode_askQuestions`) or formatted numbered lists before applying test heals.

---

## 📁 Architecture Standard

This MCP guides AI agents to structure tests under a clean Domain-Driven hierarchy:

```
tests/e2e/
├── domain/                      # Grouped by business features
│   └── {feature}/
│       ├── pages/               # Page Objects / Component Objects
│       │   └── {step}.page.ts
│       └── {feature}.fixture.ts # Custom Fixture injecting Page Objects & Data
├── factory/                     # Dynamic test data builders
│   └── {entity}.factory.ts      # Unique data per run (timestamp / Faker)
└── specs/                       # Declarative, readable test specs
    └── {feature}.spec.ts
```

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

---

## 🛠️ MCP Tools

| Tool | Description |
| :--- | :--- |
| **`run_playwright_test`** | Runs a Playwright spec file in the target project. Returns pass/fail status, comprehensive multi-file `qualityScore`, and **immediate inline failure diagnostics** (exact location, 3–5 previous steps, console errors, network failures, screenshots). |
| **`score_test_quality`** | Scores a spec file and its imported Page Objects on measurable quality signals: `% semantic locators`, assertion density, anti-patterns (`waitForTimeout`, missing `await`, index locators), and file-specific warnings. |
| **`get_failure_details`** | Deep diagnostic inspector to re-inspect specific test failure details from a previous run report. |
| **`check_playwright_config`** | Audits `playwright.config.*` for flakiness-relevant settings (`retries`, `trace`, `screenshot`, `forbidOnly`, `fullyParallel`). |
| **`set_project_root`** | Runtime fallback to manually set the target project root if auto-detection is not applicable. |

---

## 📋 MCP Prompts

* **`playwright_e2e_workflow`**: Complete end-to-end prompt instructing AI agents on the Domain-Driven POM architecture, code generation sequences (Step A to Step E), strict anti-flakiness writing rules, single-turn diagnostics, and safe healing workflows.

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
npm run dev     # tsx watch mode
npm run build   # Compile TypeScript to dist/
npm start       # Run compiled MCP server
```

---

## 📄 License

MIT


