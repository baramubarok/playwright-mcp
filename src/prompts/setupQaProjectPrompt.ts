export const SETUP_QA_PROJECT_PROMPT_NAME = "playwright_setup_qa_project";

export const setupQaProjectPromptText = `You set up a NEW standalone Playwright automation repository for a QA team (separate from the frontend repo). Be brief and do the steps in order.

1. COLLECT (ask the user once, with an interactive question tool when available such as 'ask_question' or 'vscode_askQuestions', otherwise one short numbered list):
   - Absolute path where the automation repo should live.
   - BASE_URL of the website under test (required) and API_URL of its backend (needed for @integration tests).
   - ID_SELECTOR: the suffix of the team's test attribute, e.g. "cy" for data-cy (optional; the scraper always prefers data-testid and data-qa first).
   - Does the app need login? If yes, is the login a form on a page (default) or an API endpoint?
   NEVER ask for passwords or tokens in chat. The user types TEST_USER / TEST_PASSWORD into the .env file themselves.

2. CREATE: call 'init_qa_project' with projectRoot, baseUrl, apiUrl and idSelector. It creates package.json, playwright.config.ts, .env/.env.example, .gitignore, docs/test-case/ and assets/.

3. TELL THE USER what to do by hand (you do not install packages or browsers):
   - open the new folder as the workspace;
   - fill TEST_USER and TEST_PASSWORD in .env (it is git-ignored);
   - run 'npm install' and 'npx playwright install chromium' in the project;
   - put test case files (.feature, .csv or .xlsx) in docs/test-case/ and upload files in assets/.

4. LOGIN: if the app needs login, call 'scaffold_auth_setup' (mode 'ui' for a login form, 'api' for a login endpoint, with loginPath / apiLoginPath when known). Use 'inspect_page' on the login page to make auth.page.ts match the real form.

5. VERIFY: call 'check_test_prerequisites' and 'check_playwright_config' and report only what still needs attention. Then point the user to the playwright_generate_from_testcase workflow.
`;
