export type AuthMode = "ui" | "api";

export interface AuthTemplateOptions {
  loginPath: string;
  apiLoginPath: string;
}

/** Relative to the project root; ignored by git (see GITIGNORE_TEMPLATE). */
export const AUTH_STATE_RELATIVE_PATH = ".auth/user.json";

export const AUTH_CONFIG_SOURCE = `import path from 'node:path';

/** Where auth.setup.ts saves the logged-in session; playwright.config.ts feeds it to the test projects. */
export const AUTH_FILE = path.resolve(__dirname, '../../../${AUTH_STATE_RELATIVE_PATH}');

/** Credentials come from .env (TEST_USER / TEST_PASSWORD) and are never hardcoded. */
export function getCredentials(): { username: string; password: string } {
  const username = process.env.TEST_USER?.trim();
  const password = process.env.TEST_PASSWORD;
  if (!username || !password) {
    throw new Error('TEST_USER and TEST_PASSWORD must be set in .env for the global auth setup.');
  }
  return { username, password };
}
`;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function authPageSource(options: AuthTemplateOptions): string {
  return `import { expect, type Locator, type Page } from '@playwright/test';

export class AuthPage {
  readonly page: Page;
  readonly usernameInput: Locator;
  readonly passwordInput: Locator;
  readonly submitButton: Locator;

  constructor(page: Page) {
    this.page = page;
    // Prefer data-testid / data-qa / data-{ID_SELECTOR} when the login form has them (see inspect_page);
    // these semantic locators are the fallback.
    this.usernameInput = page.getByLabel(/username|email/i);
    this.passwordInput = page.getByLabel(/password/i);
    this.submitButton = page.getByRole('button', { name: /log ?in|sign ?in/i });
  }

  async goto() {
    await this.page.goto('${options.loginPath}');
  }

  async login(username: string, password: string) {
    await this.usernameInput.fill(username);
    await this.passwordInput.fill(password);
    await this.submitButton.click();
  }

  /** Web-first assertion that the login succeeded. Tighten it to an element only visible after login. */
  async expectLoggedIn() {
    await expect(this.page).not.toHaveURL(/${escapeRegExp(options.loginPath).replace(/\//g, "\\/")}/);
  }
}
`;
}

export const AUTH_SETUP_UI_SOURCE = `import { test as setup } from '@playwright/test';
import { AuthPage } from './auth.page';
import { AUTH_FILE, getCredentials } from './auth.config';

// Runs once before the test projects (see 'setup' project in playwright.config.ts) and saves the session.
setup('authenticate', async ({ page }) => {
  const { username, password } = getCredentials();
  const authPage = new AuthPage(page);

  await setup.step('Log in through the UI', async () => {
    await authPage.goto();
    await authPage.login(username, password);
    await authPage.expectLoggedIn();
  });

  await setup.step('Save the session', async () => {
    await page.context().storageState({ path: AUTH_FILE });
  });
});
`;

export function authApiSource(options: AuthTemplateOptions): string {
  return `import { expect, type APIRequestContext } from '@playwright/test';

/** Logs in against the backend API; the session cookies end up in the request context's storage state. */
export class AuthApi {
  constructor(private readonly request: APIRequestContext) {}

  /** Align the endpoint and the payload field names with the real login API. */
  async login(username: string, password: string) {
    const response = await this.request.post('${options.apiLoginPath}', { data: { username, password } });
    await expect(response).toBeOK();
    return response;
  }
}
`;
}

export const AUTH_SETUP_API_SOURCE = `import { request, test as setup } from '@playwright/test';
import { AuthApi } from './auth.api';
import { AUTH_FILE, getCredentials } from './auth.config';

// Runs once before the test projects (see 'setup' project in playwright.config.ts) and saves the session.
setup('authenticate via API', async () => {
  const { username, password } = getCredentials();
  const apiUrl = process.env.API_URL?.trim();
  if (!apiUrl) {
    throw new Error('API_URL must be set in .env for API based authentication.');
  }

  const api = await request.newContext({ baseURL: apiUrl });
  try {
    await setup.step('Log in through the API', async () => {
      await new AuthApi(api).login(username, password);
    });
    await setup.step('Save the session', async () => {
      await api.storageState({ path: AUTH_FILE });
    });
  } finally {
    await api.dispose();
  }
});
`;

export const AUTH_PROJECTS_BLOCK = `  projects: [
    { name: 'setup', testMatch: /.*\\.setup\\.ts/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], storageState: path.resolve(__dirname, '${AUTH_STATE_RELATIVE_PATH}') },
      dependencies: ['setup'],
    },
  ],`;
