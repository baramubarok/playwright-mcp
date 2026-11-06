import { SKELETON_MARKER } from "../lib/scoreContent.js";

export type TestType = "smoke" | "ui" | "regression" | "integration";
export const ALL_TEST_TYPES: TestType[] = ["smoke", "ui", "regression", "integration"];

export interface Names {
  kebab: string;
  pascal: string;
  camel: string;
}

export interface DomainContext {
  feature: Names;
  /** Page steps; the first one is used by the example tests. */
  steps: Names[];
  /** API path the feature talks to, e.g. /api/v1/checkout. */
  apiBasePath: string;
  testTypes: TestType[];
  /** Login-style features start logged out instead of reusing the global session. */
  authFeature: boolean;
}

export interface HelperCatalogEntry {
  kind: "page" | "mock" | "api" | "factory" | "support";
  /** Fixture name to destructure in the spec (page/mock/api only). */
  fixture?: string;
  file: string;
  /** Callable members and locators available without reading the file. */
  members: string[];
}

export const PAGE_LOCATORS = ["heading", "nameInput", "emailInput", "fileInput", "submitButton", "successStatus", "errorAlert", "emptyState"];
export const PAGE_METHODS = [
  "goto()",
  "expectLoaded()",
  "fillForm(data)",
  "uploadFile(fileName)",
  "submit()",
  "expectSuccess(message?)",
  "expectError(message)",
  "expectEmptyState()",
  "expectRecordVisible(name)",
];
export const MOCK_METHODS = [
  "mockSuccess(customData?, status?)",
  "mockEmpty()",
  "mockValidationError(errors?)",
  "mockServerError(status?, message?)",
  "mockPending()",
  "waitForRequest(method?)",
];
export const API_METHODS = ["create(payload)", "getById(id)", "list()", "update(id, changes)", "remove(id)", "cleanup()"];
export const FACTORY_FUNCTIONS = ["create{Feature}Data(overrides?)", "create{Feature}Payload(overrides?)"];
export const SUPPORT_HELPERS: Array<{ file: string; members: string[] }> = [
  { file: "tests/e2e/support/selectors.ts", members: ["byTestId(scope, value)", "byQa(scope, value)", "byEnvId(scope, value)"] },
  { file: "tests/e2e/support/assets.ts", members: ["assetPath(fileName)"] },
];

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\//g, "\\/");
}

export function buildHelperCatalog(ctx: DomainContext, featureFile: (suffix: string) => string): HelperCatalogEntry[] {
  const { feature } = ctx;
  return [
    ...ctx.steps.map((step) => ({
      kind: "page" as const,
      fixture: `${step.camel}Page`,
      file: featureFile(`pages/${step.kebab}.page.ts`),
      members: [...PAGE_LOCATORS, ...PAGE_METHODS],
    })),
    { kind: "mock", fixture: `${feature.camel}Mock`, file: featureFile(`${feature.kebab}.mock.ts`), members: MOCK_METHODS },
    { kind: "api", fixture: `${feature.camel}Api`, file: featureFile(`${feature.kebab}.api.ts`), members: API_METHODS },
    {
      kind: "factory",
      file: `tests/e2e/factory/${feature.kebab}.factory.ts`,
      members: FACTORY_FUNCTIONS.map((name) => name.replace("{Feature}", feature.pascal)),
    },
    ...SUPPORT_HELPERS.map((helper) => ({ kind: "support" as const, ...helper })),
  ];
}

export function pageSource(ctx: DomainContext, step: Names): string {
  return `
import { expect, type Locator, type Page } from '@playwright/test';
import { assetPath } from '../../../support/assets';

export class ${step.pascal}Page {
  readonly page: Page;
  readonly heading: Locator;
  readonly nameInput: Locator;
  readonly emailInput: Locator;
  readonly fileInput: Locator;
  readonly submitButton: Locator;
  readonly successStatus: Locator;
  readonly errorAlert: Locator;
  readonly emptyState: Locator;

  constructor(page: Page) {
    this.page = page;
    // TODO: replace these reference locators with the ones scraped from the real page (inspect_page).
    // Priority: data-testid > data-qa > data-{ID_SELECTOR} (byTestId/byQa/byEnvId from support/selectors),
    // then semantic locators (getByRole > getByLabel/getByPlaceholder > getByText).
    this.heading = page.getByRole('heading', { level: 1 });
    this.nameInput = page.getByLabel(/name/i);
    this.emailInput = page.getByLabel(/email/i);
    this.fileInput = page.getByLabel(/upload|attachment|file/i);
    this.submitButton = page.getByRole('button', { name: /submit|save|continue/i });
    this.successStatus = page.getByRole('status');
    this.errorAlert = page.getByRole('alert');
    this.emptyState = page.getByText(/no (data|results|records|items)/i);
  }

  async goto() {
    // TODO: confirm the route; relative URLs use use.baseURL (BASE_URL in .env).
    await this.page.goto('/${ctx.feature.kebab}');
  }

  /** Web-first assertion that the page is ready for interaction. */
  async expectLoaded() {
    await expect(this.heading).toBeVisible();
  }

  async fillForm(data: { name: string; email: string }) {
    await this.nameInput.fill(data.name);
    await this.emailInput.fill(data.email);
  }

  /** Files live in the project's assets/ folder; assetPath() rejects anything else. */
  async uploadFile(fileName: string) {
    await this.fileInput.setInputFiles(assetPath(fileName));
  }

  async submit() {
    await this.submitButton.click();
  }

  async expectSuccess(message: string | RegExp = /success/i) {
    await expect(this.successStatus).toContainText(message);
  }

  async expectError(message: string | RegExp) {
    await expect(this.errorAlert).toContainText(message);
  }

  async expectEmptyState() {
    await expect(this.emptyState).toBeVisible();
  }

  async expectRecordVisible(name: string) {
    await expect(this.page.getByText(name)).toBeVisible();
  }
}
`;
}

export function mockSource(ctx: DomainContext): string {
  const { feature } = ctx;
  return `
import type { Page, Request } from '@playwright/test';

/** Matches ${ctx.apiBasePath}, ${ctx.apiBasePath}/... and query strings. TODO: align with the real API (network tab). */
export const ${feature.camel}ApiPattern = /${escapeRegexLiteral(ctx.apiBasePath)}(?:[/?#]|$)/;

/** Mocked API responses for @ui tests. Specs call these methods; they never use page.route() themselves. */
export class ${feature.pascal}Mock {
  constructor(private readonly page: Page) {}

  async mockSuccess(customData?: Record<string, unknown>, status = 200) {
    await this.page.route(${feature.camel}ApiPattern, async (route) => {
      await route.fulfill({ status, json: { success: true, message: 'Success', ...customData } });
    });
  }

  async mockEmpty() {
    await this.page.route(${feature.camel}ApiPattern, async (route) => {
      await route.fulfill({ status: 200, json: { success: true, data: [] } });
    });
  }

  /** 422 with field errors, e.g. { email: 'Invalid email' }. */
  async mockValidationError(errors: Record<string, string> = { email: 'Invalid email' }) {
    await this.page.route(${feature.camel}ApiPattern, async (route) => {
      await route.fulfill({ status: 422, json: { success: false, errors } });
    });
  }

  async mockServerError(status = 500, message = 'Internal Server Error') {
    await this.page.route(${feature.camel}ApiPattern, async (route) => {
      await route.fulfill({ status, json: { success: false, message } });
    });
  }

  /** Holds the response until the returned release() is called, to assert loading states without sleeps. */
  async mockPending(): Promise<() => void> {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await this.page.route(${feature.camel}ApiPattern, async (route) => {
      await gate;
      await route.fulfill({ status: 200, json: { success: true } });
    });
    return release;
  }

  /** Resolves with the next matching request so a test can assert what the UI sent. */
  waitForRequest(method = 'POST'): Promise<Request> {
    return this.page.waitForRequest((request) => ${feature.camel}ApiPattern.test(request.url()) && request.method() === method);
  }
}
`;
}

export function apiSource(ctx: DomainContext): string {
  const { feature } = ctx;
  return `
import { expect, type APIRequestContext } from '@playwright/test';

/** Request body for creating a record. TODO: keep in sync with the real API and factory/${feature.kebab}.factory.ts. */
export type ${feature.pascal}Payload = {
  name: string;
  email: string;
};

export type ${feature.pascal}Record = ${feature.pascal}Payload & {
  id: string;
};

const BASE_PATH = '${ctx.apiBasePath}';

/**
 * Real backend calls for @integration tests (requests go to API_URL from .env). Specs must call these
 * methods; when a test needs another endpoint, add a method here instead of writing request.* in the spec.
 */
export class ${feature.pascal}Api {
  private readonly createdIds: string[] = [];

  constructor(private readonly request: APIRequestContext) {}

  /** Creates a record and tracks it so cleanup() removes it after the test. */
  async create(payload: ${feature.pascal}Payload): Promise<${feature.pascal}Record> {
    const response = await this.request.post(BASE_PATH, { data: payload });
    await expect(response).toBeOK();
    const record = (await response.json()) as ${feature.pascal}Record;
    this.createdIds.push(record.id);
    return record;
  }

  async getById(id: string): Promise<${feature.pascal}Record> {
    const response = await this.request.get(BASE_PATH + '/' + encodeURIComponent(id));
    await expect(response).toBeOK();
    return (await response.json()) as ${feature.pascal}Record;
  }

  async list(): Promise<${feature.pascal}Record[]> {
    const response = await this.request.get(BASE_PATH);
    await expect(response).toBeOK();
    return (await response.json()) as ${feature.pascal}Record[];
  }

  async update(id: string, changes: Partial<${feature.pascal}Payload>): Promise<${feature.pascal}Record> {
    const response = await this.request.patch(BASE_PATH + '/' + encodeURIComponent(id), { data: changes });
    await expect(response).toBeOK();
    return (await response.json()) as ${feature.pascal}Record;
  }

  async remove(id: string): Promise<void> {
    const response = await this.request.delete(BASE_PATH + '/' + encodeURIComponent(id));
    await expect(response).toBeOK();
    const index = this.createdIds.indexOf(id);
    if (index >= 0) this.createdIds.splice(index, 1);
  }

  /** Deletes every record created through create(); the fixture calls it after each test and it never throws. */
  async cleanup(): Promise<void> {
    for (const id of this.createdIds.splice(0)) {
      await this.request.delete(BASE_PATH + '/' + encodeURIComponent(id)).catch(() => undefined);
    }
  }
}
`;
}

export function fixtureSource(ctx: DomainContext): string {
  const { feature } = ctx;
  const imports = ctx.steps.map((step) => `import { ${step.pascal}Page } from './pages/${step.kebab}.page';`).join("\n");
  const types = ctx.steps.map((step) => `  ${step.camel}Page: ${step.pascal}Page;`).join("\n");
  const pages = ctx.steps
    .map((step) => `  ${step.camel}Page: async ({ page }, use) => {\n    await use(new ${step.pascal}Page(page));\n  },`)
    .join("\n");
  return `
import { test as base, expect } from '../../support/diagnostics.fixture';
${imports}
import { ${feature.pascal}Mock } from './${feature.kebab}.mock';
import { ${feature.pascal}Api } from './${feature.kebab}.api';

type ${feature.pascal}Fixtures = {
${types}
  ${feature.camel}Mock: ${feature.pascal}Mock;
  ${feature.camel}Api: ${feature.pascal}Api;
};

export const test = base.extend<${feature.pascal}Fixtures>({
${pages}
  ${feature.camel}Mock: async ({ page }, use) => {
    await use(new ${feature.pascal}Mock(page));
  },
  ${feature.camel}Api: async ({ playwright, baseURL, storageState }, use) => {
    // API_URL (.env) is the backend; fall back to the web baseURL when both share one origin.
    // The saved login session is reused, which works when the API accepts the site's cookies.
    const context = await playwright.request.newContext({ baseURL: process.env.API_URL?.trim() || baseURL, storageState });
    const api = new ${feature.pascal}Api(context);
    try {
      await use(api);
    } finally {
      await api.cleanup();
      await context.dispose();
    }
  },
});

export { expect };
`;
}

export function factorySource(ctx: DomainContext): string {
  const { feature } = ctx;
  return `
import type { ${feature.pascal}Payload } from '../domain/${feature.kebab}/${feature.kebab}.api';

export interface ${feature.pascal}Data {
  id: string;
  name: string;
  email: string;
  createdAt: number;
}

/**
 * Generate unique, dynamic data for ${feature.pascal} tests. The random suffix keeps values unique
 * across parallel workers and re-runs, preventing unique-constraint collisions.
 */
export function create${feature.pascal}Data(overrides?: Partial<${feature.pascal}Data>): ${feature.pascal}Data {
  const createdAt = Date.now();
  const unique = createdAt + '-' + Math.random().toString(36).slice(2, 8);
  return {
    id: '${feature.kebab}_' + unique,
    name: 'Test User ' + unique,
    email: '${feature.kebab}.' + unique + '@example.com',
    createdAt,
    ...overrides,
  };
}

/** Body for ${feature.pascal}Api.create() and for filling the form; override single fields as needed. */
export function create${feature.pascal}Payload(overrides?: Partial<${feature.pascal}Payload>): ${feature.pascal}Payload {
  const data = create${feature.pascal}Data();
  return { name: data.name, email: data.email, ...overrides };
}
`;
}

export function specSource(ctx: DomainContext): string {
  const { feature } = ctx;
  const page = `${ctx.steps[0].camel}Page`;
  const mock = `${feature.camel}Mock`;
  const api = `${feature.camel}Api`;
  const create = `create${feature.pascal}Payload`;
  const wants = (type: TestType) => ctx.testTypes.includes(type);

  const blocks: string[] = [];

  if (wants("smoke")) {
    blocks.push(`
  // SMOKE: the critical happy path with the API mocked.
  test.fixme('should complete ${feature.kebab} happy path @smoke @ui', async ({ ${page}, ${mock} }) => {
    const payload = ${create}();

    await test.step('Mock API responses', async () => {
      await ${mock}.mockSuccess({ id: 'mock-id' });
    });

    await test.step('Open the page', async () => {
      await ${page}.goto();
      await ${page}.expectLoaded();
    });

    await test.step('Submit the form and assert the outcome', async () => {
      await ${page}.fillForm(payload);
      await ${page}.submit();
      await ${page}.expectSuccess();
    });
  });`);
  }

  if (wants("ui")) {
    blocks.push(`
  // UI: error, validation and empty states, all driven by the mock helper.
  test.fixme('should show the server error when the API fails @ui', async ({ ${page}, ${mock} }) => {
    await test.step('Mock a 500 server error', async () => {
      await ${mock}.mockServerError(500);
    });

    await test.step('Submit the form', async () => {
      await ${page}.goto();
      await ${page}.fillForm(${create}());
      await ${page}.submit();
    });

    await test.step('Assert the error is shown', async () => {
      await ${page}.expectError(/error|failed/i);
    });
  });

  test.fixme('should show validation errors returned by the API @ui', async ({ ${page}, ${mock} }) => {
    await test.step('Mock a 422 validation error', async () => {
      await ${mock}.mockValidationError({ email: 'Invalid email' });
    });

    await test.step('Submit the form', async () => {
      await ${page}.goto();
      await ${page}.fillForm(${create}());
      await ${page}.submit();
    });

    await test.step('Assert the validation message is shown', async () => {
      await ${page}.expectError('Invalid email');
    });
  });

  test.fixme('should show the empty state when there is no data @ui', async ({ ${page}, ${mock} }) => {
    await test.step('Mock an empty response', async () => {
      await ${mock}.mockEmpty();
    });

    await test.step('Open the page and assert the empty state', async () => {
      await ${page}.goto();
      await ${page}.expectEmptyState();
    });
  });`);
  }

  if (wants("regression")) {
    blocks.push(`
  // REGRESSION: a multi-step flow that also verifies what the UI sent to the API.
  test.fixme('should send the entered data and confirm it to the user @regression @ui', async ({ ${page}, ${mock} }) => {
    const payload = ${create}();
    await ${mock}.mockSuccess();
    const sentRequest = ${mock}.waitForRequest('POST');

    await test.step('Fill and submit the form', async () => {
      await ${page}.goto();
      await ${page}.expectLoaded();
      await ${page}.fillForm(payload);
      await ${page}.submit();
    });

    await test.step('Assert the payload sent by the UI', async () => {
      expect((await sentRequest).postDataJSON()).toMatchObject(payload);
    });

    await test.step('Assert the confirmation', async () => {
      await ${page}.expectSuccess();
    });
  });`);
  }

  if (wants("integration")) {
    blocks.push(`
  // INTEGRATION: real backend. Arrange and verify through ${api} (never inline request.* here);
  // records created with ${api}.create() are deleted automatically by the fixture.
  test.fixme('should show a record created through the API @integration', async ({ ${page}, ${api} }) => {
    const record = await test.step('Arrange: create the record through the API', async () => {
      return ${api}.create(${create}());
    });

    await test.step('Act: open the page', async () => {
      await ${page}.goto();
      await ${page}.expectLoaded();
    });

    await test.step('Assert in the UI', async () => {
      await ${page}.expectRecordVisible(record.name);
    });

    await test.step('Assert in the backend', async () => {
      const stored = await ${api}.getById(record.id);
      expect(stored.email).toBe(record.email);
    });
  });

  test.fixme('should persist data submitted through the UI @integration', async ({ ${page}, ${api} }) => {
    const payload = ${create}();

    await test.step('Act: submit the form in the UI', async () => {
      await ${page}.goto();
      await ${page}.fillForm(payload);
      await ${page}.submit();
      await ${page}.expectSuccess();
    });

    await test.step('Assert in the backend, then clean up the record created by the UI', async () => {
      const created = (await ${api}.list()).find((record) => record.email === payload.email);
      expect(created).toBeDefined();
      await ${api}.remove(created!.id);
    });
  });`);
  }

  const loggedOut = ctx.authFeature
    ? `
  // Start logged out: ignore the global session saved by auth.setup.ts.
  test.use({ storageState: { cookies: [], origins: [] } });
`
    : "";

  return `
// ${SKELETON_MARKER}: generated by scaffold_test_domain. The tests below are reference examples (test.fixme, skipped):
//   @smoke / @ui = mocked API | @regression = payload + multi-step | @integration = real API through ${api}.
// Replace the placeholder locators in the page object and the sample data, then change test.fixme to test and
// remove this marker. Reuse the ${page}, ${mock} and ${api} fixtures; add new methods to those files instead of
// writing request.* or page.route() in this spec. score_test_quality reports the file as a skeleton until then.
import { test, expect } from '../domain/${feature.kebab}/${feature.kebab}.fixture';
import { ${create} } from '../factory/${feature.kebab}.factory';

test.describe('${feature.pascal} Flow', () => {${loggedOut}${blocks.join("\n")}
});
`;
}
