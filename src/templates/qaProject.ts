export interface QaProjectTemplateOptions {
  projectName: string;
  baseUrl: string;
  apiUrl: string;
  idSelector: string;
}

export const PLAYWRIGHT_TEST_VERSION = "^1.49.0";

export function packageJsonTemplate(options: QaProjectTemplateOptions): string {
  return JSON.stringify(
    {
      name: options.projectName,
      version: "0.1.0",
      private: true,
      description: "Playwright E2E automation project (QA).",
      scripts: {
        test: "playwright test",
        "test:smoke": "playwright test --grep @smoke",
        "test:ui": "playwright test --grep @ui",
        "test:regression": "playwright test --grep @regression",
        "test:integration": "playwright test --grep @integration",
        typecheck: "tsc --noEmit",
        report: "playwright show-report",
      },
      devDependencies: {
        "@playwright/test": PLAYWRIGHT_TEST_VERSION,
        "@types/node": "^22.10.5",
        dotenv: "^16.4.7",
        typescript: "^5.7.3",
      },
    },
    null,
    2,
  );
}

export const TSCONFIG_TEMPLATE = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "moduleResolution": "node",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["playwright.config.ts", "tests/**/*.ts"]
}
`;

/** The single project the QA template starts with; scaffold_auth_setup replaces exactly this line. */
export const DEFAULT_PROJECTS_LINE = "  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],";

export const PLAYWRIGHT_CONFIG_TEMPLATE = `import path from 'node:path';
import dotenv from 'dotenv';
import { defineConfig, devices } from '@playwright/test';

// Target URL, API URL and selector attribute come from .env (copy .env.example to .env).
dotenv.config({ path: path.resolve(__dirname, '.env') });

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error('Missing required environment variable ' + name + '. Copy .env.example to .env and set it.');
  }
  return value;
}

const baseURL = requireEnv('BASE_URL');
const idSelector = process.env.ID_SELECTOR?.trim();

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [['html', { open: 'never' }], ['list']],
  use: {
    baseURL,
    // getByTestId() reads data-{ID_SELECTOR} (e.g. data-qa); defaults to data-testid.
    testIdAttribute: idSelector ? 'data-' + idSelector : 'data-testid',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
${DEFAULT_PROJECTS_LINE}
});
`;

export function envTemplate(options: QaProjectTemplateOptions, kind: "example" | "local"): string {
  const base = kind === "local" ? options.baseUrl : options.baseUrl || "https://your-app.example.com";
  const api = kind === "local" ? options.apiUrl : options.apiUrl || "https://api.your-app.example.com";
  return `# Target application under test (required)
BASE_URL=${base}

# Backend API used by @integration tests
API_URL=${api}

# Selector attribute suffix: "qa" means data-qa is used by getByTestId().
# Selector priority when scraping: data-testid > data-qa > data-{ID_SELECTOR} > semantic (role/label/text).
ID_SELECTOR=${options.idSelector}

# Test account used by the global auth setup. Never commit real credentials.
TEST_USER=
TEST_PASSWORD=
`;
}

export const GITIGNORE_TEMPLATE = `node_modules/
.env
.auth/
playwright-report/
test-results/
blob-report/
allure-results/
allure-report/
.pw-mcp-*.config.ts
`;

export const TEST_CASE_README = `# Test cases

Put the test case files written by QA in this folder. The MCP reads them (\`read_test_cases\`) before it inspects the website and generates tests.

## Supported formats

### Gherkin (\`*.feature\`)
One \`Feature\` per file, one \`Scenario\` per test case. Put the test case ID and priority in tags:

\`\`\`gherkin
Feature: Login

  @TC-001 @smoke
  Scenario: Valid user can log in
    Given I am on the login page
    When I fill in valid credentials
    Then I see the dashboard
\`\`\`

### CSV (\`*.csv\`)
First row is the header. Column names are case-insensitive:

| Column | Required | Notes |
|---|---|---|
| \`ID\` | yes | e.g. \`TC-001\`, becomes the \`@TC-001\` tag in the generated test |
| \`Title\` | yes | |
| \`Preconditions\` | no | |
| \`Steps\` | yes | separate steps with \`;\` |
| \`Expected Result\` | yes | separate results with \`;\` |
| \`Priority\` | no | \`smoke\`, \`regression\`, or \`P1\`/\`P2\`/\`P3\` |

### Excel (\`*.xlsx\`)
Same columns as CSV, first sheet only. Needs the optional \`exceljs\` package.

See \`example.feature\` and \`example.csv\` in this folder. Delete the examples when you add real test cases.
`;

export const TEST_CASE_EXAMPLE_FEATURE = `Feature: Login (example)

  @TC-001 @smoke
  Scenario: Valid user can log in
    Given I am on the login page
    When I fill in a valid username and password
    And I submit the form
    Then I am redirected to the dashboard

  @TC-002 @regression
  Scenario: Invalid password shows an error
    Given I am on the login page
    When I fill in a valid username and a wrong password
    And I submit the form
    Then I see an error message
`;

export const TEST_CASE_EXAMPLE_CSV = `ID,Title,Preconditions,Steps,Expected Result,Priority
TC-101,Valid user can log in,User account exists,Open the login page; Fill username and password; Click Login,User lands on the dashboard,smoke
TC-102,Invalid password shows an error,User account exists,Open the login page; Fill username and a wrong password; Click Login,An error message is shown,regression
`;

export const ASSETS_README = `# Assets

Files used by tests, for example documents or images for upload steps.

- Put the file here, then reference it in a page object with \`assetPath('file-name.png')\` from \`tests/e2e/support/assets.ts\`.
- \`assetPath()\` rejects any path outside this folder and files that do not exist.
- Do not store real customer data or secrets here.
`;

export const ASSET_HELPER_SOURCE = `import { existsSync } from 'node:fs';
import path from 'node:path';

const ASSETS_DIR = path.resolve(__dirname, '../../../assets');

/** Resolves a file inside the project's assets/ folder for upload steps; rejects anything outside it. */
export function assetPath(fileName: string): string {
  const resolved = path.resolve(ASSETS_DIR, fileName);
  const relative = path.relative(ASSETS_DIR, resolved);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Asset "' + fileName + '" must be a file inside the assets/ folder.');
  }
  if (!existsSync(resolved)) {
    throw new Error('Asset "' + fileName + '" was not found in assets/. Put the file there first.');
  }
  return resolved;
}
`;

/**
 * Stable attribute locators. Selector priority when generating tests:
 * data-testid > data-qa > data-{ID_SELECTOR} > semantic (getByRole/getByLabel/getByPlaceholder/getByText).
 */
export const SELECTORS_HELPER_SOURCE = `import type { Locator, Page } from '@playwright/test';

type Scope = Page | Locator;

function attributeSelector(attribute: string, value: string): string {
  const escaped = value.replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"');
  return '[' + attribute + '="' + escaped + '"]';
}

/** [data-testid="value"], regardless of use.testIdAttribute in playwright.config. */
export function byTestId(scope: Scope, value: string): Locator {
  return scope.locator(attributeSelector('data-testid', value));
}

/** [data-qa="value"]. */
export function byQa(scope: Scope, value: string): Locator {
  return scope.locator(attributeSelector('data-qa', value));
}

/** [data-{ID_SELECTOR}="value"], using the ID_SELECTOR suffix from .env (e.g. ID_SELECTOR=cy -> data-cy). */
export function byEnvId(scope: Scope, value: string): Locator {
  const suffix = process.env.ID_SELECTOR?.trim();
  if (!suffix) {
    throw new Error('ID_SELECTOR is not set in .env; byEnvId() needs it.');
  }
  return scope.locator(attributeSelector('data-' + suffix, value));
}
`;
