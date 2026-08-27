export const WORKFLOW_GUIDE_PROMPT_NAME = "playwright_e2e_workflow";

export const workflowGuideText = `You are generating and maintaining enterprise-grade, highly maintainable, and flake-resistant Playwright E2E tests using this MCP server's tools. Follow this comprehensive architecture standard, strict writing rules, and step-by-step workflow:

===================================================================
1. ARCHITECTURE STANDARD: DOMAIN-DRIVEN POM WITH CUSTOM FIXTURES
===================================================================
Always structure tests under the following folder hierarchy:
tests/e2e/
├── domain/                      # Grouped by business features
│   └── {feature}/
│       ├── pages/               # Page Objects for this domain
│       │   └── {step}.page.ts
│       └── {feature}.fixture.ts # Custom Fixture injecting Page Objects & Test Data
├── factory/                     # Dynamic test data builders
│   └── {entity}.factory.ts      # Generates dynamic unique test data (timestamp / Faker)
└── specs/                       # Declarative test specs
    └── {feature}.spec.ts

CORE ARCHITECTURAL PRINCIPLES:
1. Strict Separation: NEVER write raw locators or direct UI interactions inside \`.spec.ts\` files. All UI interactions must go through Page Object methods (\`.page.ts\`).
2. Custom Fixtures: ALWAYS use Playwright custom fixtures (\`base.extend<Fixtures>\`) to inject Page Objects and Test Data into tests. Do NOT manually instantiate classes using \`new PageName()\` inside specs.
3. Dynamic Data Factories: ALWAYS generate unique test data in \`factory/\` (e.g. \`Date.now()\` or Faker) to prevent database unique-constraint collisions on test re-runs.
4. Semantic Locators in Page Objects: Declare \`readonly\` locators using semantic queries (\`getByRole\`, \`getByLabel\`, \`getByPlaceholder\`, \`getByText\`, \`getByTestId\`).

===================================================================
2. RULES WRITING (ANTI-FLAKINESS & ROBUSTNESS)
===================================================================
- Black-Box Perspective: Write tests as black-box, user-observable behaviors rather than internal implementation details.
- Locator Priority & Hygiene:
  * Priority: \`getByRole\` > \`getByLabel\` / \`getByPlaceholder\` > \`getByText\` > \`getByTestId\`.
  * FORBIDDEN: Fragile CSS/XPath selectors (e.g. \`input[name="email"]\`, \`button.btn-primary\`) and deep nested CSS chains (\`div > div > span\`).
  * Index Locators: Avoid \`.nth()\`, \`.first()\`, \`.last()\` unless order is truly meaningful and properly scoped within a parent container.
- Waiting & Synchronization (CRITICAL):
  * FORBIDDEN: Never use arbitrary sleeps like \`waitForTimeout(...)\` or a manual \`setTimeout\` sleep. Arbitrary sleeps are the #1 cause of flaky tests.
  * Use web-first auto-retrying assertions (\`await expect(locator).toBeVisible()\`, \`await expect(locator).toHaveText()\`) or wait on specific conditions (\`waitForResponse\` / \`waitForURL\`).
  * Avoid \`waitForLoadState('networkidle')\` as it is highly flaky in local/CI environments; prefer \`'domcontentloaded'\` or waiting for specific selectors/API responses instead.
  * Prefer \`expect(locator).toHaveText()\` / \`.toContainText()\` over manually reading \`.textContent()\` / \`.innerText()\` and comparing — manual extraction does not auto-retry.
- Actions & Independence:
  * Every action (\`click\`, \`fill\`, \`check\`, \`selectOption\`, \`press\`, etc.) MUST be awaited — a missing await is a race condition, not a working test.
  * Each test must be independent: set up its own state via fixture / \`beforeEach\`, don't rely on another test having run first, and use unique test data from \`factory/\` so parallel/repeated runs never collide.
  * Group related tests with \`test.describe(...)\` and break long tests into \`test.step(...)\` for clearer trace segmentation when diagnosing failures.
- Test Strategy, Mocking & Tagging:
  * Tagging Conventions: Pair test titles with descriptive tags — \`@smoke\` (critical happy path), \`@regression\` (comprehensive flows), \`@ui\` (mocked frontend UI validation), or \`@integration\` (real backend API validation).
  * Mocking Policy: For fast, deterministic UI testing and edge-case simulation (e.g. 400, 422, 500 error banners, network timeouts), use \`page.route()\` to stub API responses, unless the developer explicitly requests real backend integration testing.

===================================================================
3. STEP-BY-STEP WORKFLOW
===================================================================

0. CONFIGURE & CHECK ENVIRONMENT
   - Target project root is automatically discovered from the test file or workspace. If auto-detection fails, use \`set_project_root\` or pass \`projectRoot\` directly.
   - Run \`check_playwright_config\` (once per project, not per spec). Resolve its warnings if you're able to (retries, trace, screenshot, forbidOnly, fullyParallel) — these affect every test's diagnosability and flakiness.

1. UNDERSTAND THE FLOW (using native IDE file exploration tools)
   - Read the relevant FSD (functional spec doc) and component/page code to map out the user journey and expected DOM outcomes.
   - If an existing FSD is not available, infer the expected behavior directly from the code itself (routes, form fields, API calls, state changes, conditional rendering).

2. GENERATE CODE SEQUENCE (Domain POM + Fixture + Factory + Spec)
   - Step A: Create Page Object(s) in \`tests/e2e/domain/{feature}/pages/{step}.page.ts\` with \`readonly\` semantic locators and semantic action methods.
   - Step B: Create Data Factory in \`tests/e2e/factory/{entity}.factory.ts\` for dynamic dummy data.
   - Step C: Create Custom Fixture in \`tests/e2e/domain/{feature}/{feature}.fixture.ts\` extending \`base.extend\`.
   - Step D: Create Spec in \`tests/e2e/specs/{feature}.spec.ts\`. Keep specs clean, readable, wrapped in \`test.step(...)\`, tagged appropriately (\`@smoke\`/\`@regression\`/\`@ui\`/\`@integration\`), and using web-first assertions (\`await expect(locator).toBeVisible()\`, \`await expect(page).toHaveURL(...)\`).
   - Step E: Run \`score_test_quality\` on spec and page files to verify locator quality and detect anti-patterns before running.

3. RUN AND DIAGNOSE (Single-Turn UX)
   - Execute the spec with \`run_playwright_test\`. Keep the \`reportPath\` from the result.
   - MANDATORY REPORTING: In your response to the user, ALWAYS render a Markdown table of the \`qualityScore\` (showing % semantic locators, total assertions, anti-patterns, and file-level warnings) so the user immediately sees code/locator health.
   - If tests fail, \`run_playwright_test\` immediately returns inline failure diagnostics:
     - Exact line number and file location
     - Categorized error type (\`locator_not_found\`, \`timeout\`, \`assertion_failed\`, \`network\`)
     - The last 3–5 action steps before the failure
     - Browser console errors and failed HTTP requests (4xx/5xx)
     - Screenshot & trace paths, and call log excerpts
   - Classify failures by \`errorType\`:
     - "locator_not_found": the element's role/text/testid likely changed or moved. Re-read the current source to find the new identity before rewriting the locator in the Page Object.
     - "timeout": likely an async/loading issue, not a locator problem — investigate app behavior before touching the test.
     - "assertion_failed": the app's actual output differs from expected — treat as a POSSIBLE REGRESSION FIRST, not a test bug.
     - "network": check whether the app under test or mock API is actually reachable/running.
   - Deep inspection: \`get_failure_details\` is available for re-inspecting specific test details if needed.

4. HEALING RULES — DO NOT AUTO-PATCH BLINDLY
   - When fixing a locator, edit the Page Object file (\`.page.ts\`), not the spec file.
   - Only adjust a locator if the element's identity (role + accessible name, or testid) is preserved and only the DOM position/structure moved.
   - If the identity itself changed (different role, different text, different testid) OR the element is gone entirely, DO NOT silently rewrite the test to pass. Flag it for human review and explain what changed — this may be a real regression, not a stale locator.
   - Never loosen an assertion (e.g. widening a text match, removing an expect) just to make a test pass.
   - To confirm with the user before applying fixes:
     * If an interactive choice tool is available in your environment (e.g. \`ask_question\`, \`vscode_askQuestions\`), MUST use it to present options: ['Apply Fix & Re-run', 'Review Diff First', 'Cancel'].
     * Otherwise, format the choices as a clean numbered list in chat so the user can easily select with just a number.`;




