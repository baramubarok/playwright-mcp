export const GENERATE_FROM_TESTCASE_PROMPT_NAME = "playwright_generate_from_testcase";

/** `ids` is an optional comma separated list of test case IDs (e.g. "TC-001, TC-002"). */
export function generateFromTestCasePromptText(ids?: string): string {
  const selection = ids?.trim()
    ? `Implement ONLY these test cases: ${ids.trim()} (pass them as 'ids' to read_test_cases).`
    : "Implement the test cases the user names. When none are named, call read_test_cases without ids, show the list (id, title, priority) and ask which ones to implement first.";

  return `You generate Playwright tests for a QA team FROM THEIR TEST CASES, using the LIVE WEBSITE as the source of truth. Never read or ask for frontend source code.
${selection}

Follow these steps in order. Keep chat output short (a few lines per step); put the detail in files.

1. PREFLIGHT
   - Call 'check_test_prerequisites'. Fix blocking items first (missing .env keys, docs/test-case/, Playwright or browsers: tell the user the exact command to run; never install anything silently).
   - If the app needs login and no global auth exists, plan to call 'scaffold_auth_setup' (step 4).

2. UNDERSTAND THE TEST CASES
   - Call 'read_test_cases' (with ids). Check 'warnings' and 'skippedFiles'; resolve problems with the user.
   - For each test case list: the page(s) it touches, the data it needs, every step and every expected result. Do not add, drop or reinterpret steps. Ask the user when something is ambiguous.
   - Group test cases into features (one 'scaffold_test_domain' per feature; one page step per distinct page or wizard step).

3. SCRAPE THE LIVE SITE
   - For every page call 'inspect_page' (path relative to BASE_URL). Use 'useAuth: true' for pages behind login.
   - Reach hidden states with 'steps' (open the modal, submit an invalid form, go to the next wizard step) and name them with 'snapshot'. Use {{TEST_USER}} / {{TEST_PASSWORD}} for credentials.
   - Use the returned 'locator' expressions as they are (data-testid > data-qa > data-{ID_SELECTOR} > semantic). Do not invent locators or data-* attributes. Scope 'ambiguous' locators inside a container.
   - Note the real texts of success/error messages, they become assertions.

4. SCAFFOLD
   - 'scaffold_test_domain' per feature (featureName, steps, apiBasePath when known, testTypes for the styles you need). Auth-like features also get the global auth handler; otherwise call 'scaffold_auth_setup' once.
   - Use the returned 'helperCatalog' to know every page/mock/api method already available.

5. IMPLEMENT (one test per test case)
   - Page objects: replace the reference locators with the scraped ones; add one action method per user step and one assertion method per expected result.
   - Mock/api files: set the real endpoint, payload type and response shape. When a test needs another endpoint or mock, ADD A METHOD there. NEVER write request.*, fetch or page.route() in the spec.
   - Spec: title '[TC-001] <test case title>' plus the tag @TC-001 and its priority tag (@smoke, @regression); steps in test.step(...) using the test case wording; every expected result is an assertion. @integration tests must use the {feature}Api fixture.
   - Remove reference examples that no test case needs; change test.fixme to test and delete the @mcp-skeleton marker only on tests you really implemented.
   - Test data comes from the factory (unique values); files to upload come from assets/ via assetPath(); credentials from .env.

6. VERIFY
   - 'score_test_quality' on each spec: skeleton false, no inlineApiCall / inlineRoute / integrationWithoutApiHelper, stable-locator % high. Fix findings.
   - 'run_playwright_test' (specPath or grep '@TC-001'). On failure follow the playwright_run_and_heal workflow: re-inspect the page with 'inspect_page' before changing a locator.

7. REPORT (max 6 lines)
   - Per test case: id, status, spec file. Mention warnings, assumptions you made and test cases you could not implement, with the reason.
`;
}
