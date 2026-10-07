import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { findProjectRoot } from "../lib/config.js";
import { resolveProjectPath } from "../lib/pathSecurity.js";
import { SKELETON_MARKER } from "../lib/scoreContent.js";
import {
  assertSafeIdentifier,
  assertUniqueNormalizedIdentifiers,
  safeIdentifierSchema,
} from "../lib/safeIdentifier.js";

export const scaffoldTestDomainInputShape = {
  featureName: safeIdentifierSchema
    .describe("Name of the domain feature in kebab-case or camelCase, e.g. \"auth\", \"checkout\", or \"user-profile\" (max 64 characters)."),
  steps: z
    .array(safeIdentifierSchema)
    .optional()
    .describe(
      "Optional list of step/page names for this feature, e.g. [\"email\", \"otp\", \"password\"]. Defaults to [featureName]."
    ),
  projectRoot: z
    .string()
    .optional()
    .describe("Optional path to target project root. Auto-detected if omitted."),
  overwrite: z
    .boolean()
    .optional()
    .describe("Whether to overwrite existing files if they already exist. Default: false."),
};

export const scaffoldTestDomainSchema = z.object(scaffoldTestDomainInputShape);
export type ScaffoldTestDomainInput = z.infer<typeof scaffoldTestDomainSchema>;

export interface ScaffoldTestDomainOutput {
  feature: string;
  createdFiles: string[];
  skippedFiles: string[];
  domainDir: string;
  specFile: string;
  factoryFile: string;
  /** Shared fixture that records browser console/page/network events for MCP diagnostics. */
  diagnosticsFixtureFile: string;
  /** Generated specs are explicit skeletons: tests are test.fixme until their TODOs are implemented. */
  skeleton: true;
  nextSteps: string[];
}

function toPascalCase(str: string): string {
  return str
    .replace(/[-_](.)/g, (_, c) => c.toUpperCase())
    .replace(/^[a-z]/, (c) => c.toUpperCase());
}

function toCamelCase(str: string): string {
  const pascal = toPascalCase(str);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

function toKebabCase(str: string): string {
  return str
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();
}

export function scaffoldTestDomain(input: ScaffoldTestDomainInput): ScaffoldTestDomainOutput {
  assertSafeIdentifier(input.featureName, "featureName");
  const requestedStepNames = input.steps && input.steps.length > 0 ? input.steps : undefined;
  for (const [index, step] of (requestedStepNames ?? []).entries()) {
    assertSafeIdentifier(step, `steps[${index}]`);
  }

  const root = findProjectRoot(undefined, input.projectRoot);
  const featureKebab = toKebabCase(input.featureName);
  const featurePascal = toPascalCase(input.featureName);
  const featureCamel = toCamelCase(input.featureName);

  const stepNames = requestedStepNames ?? [featureKebab];
  assertUniqueNormalizedIdentifiers(stepNames, "steps", toKebabCase);

  const baseE2eDir = path.join(root, "tests", "e2e");
  const domainDir = path.join(baseE2eDir, "domain", featureKebab);
  const pagesDir = path.join(domainDir, "pages");
  const factoryDir = path.join(baseE2eDir, "factory");
  const specsDir = path.join(baseE2eDir, "specs");
  const supportDir = path.join(baseE2eDir, "support");
  const diagnosticsFixturePath = path.join(supportDir, "diagnostics.fixture.ts");

  const destinationDirs = [pagesDir, factoryDir, specsDir, supportDir];
  const destinationFiles = [
    diagnosticsFixturePath,
    ...stepNames.map((step) => path.join(pagesDir, `${toKebabCase(step)}.page.ts`)),
    path.join(domainDir, `${featureKebab}.mock.ts`),
    path.join(domainDir, `${featureKebab}.api.ts`),
    path.join(domainDir, `${featureKebab}.fixture.ts`),
    path.join(factoryDir, `${featureKebab}.factory.ts`),
    path.join(specsDir, `${featureKebab}.spec.ts`),
  ];

  // Preflight every destination before creating any directory or file.
  for (const directory of destinationDirs) {
    resolveProjectPath(directory, root, { forWrite: true });
  }
  for (const file of destinationFiles) {
    resolveProjectPath(file, root, { forWrite: true });
  }

  for (const directory of destinationDirs) mkdirSync(directory, { recursive: true });

  const createdFiles: string[] = [];
  const skippedFiles: string[] = [];

  function safeWriteFile(filePath: string, content: string, options: { shared?: boolean } = {}) {
    const relPath = path.relative(root, filePath);
    // Shared support files may have been customized for every feature, so they are never overwritten.
    const overwrite = input.overwrite && !options.shared;
    if (existsSync(filePath) && !overwrite) {
      skippedFiles.push(relPath);
      return;
    }
    writeFileSync(filePath, content.trim() + "\n", {
      encoding: "utf-8",
      flag: overwrite ? "w" : "wx",
    });
    createdFiles.push(relPath);
  }

  // 0. Shared diagnostics fixture (support/diagnostics.fixture.ts)
  safeWriteFile(diagnosticsFixturePath, DIAGNOSTICS_FIXTURE_SOURCE, { shared: true });

  // 1. Generate Page Object(s)
  const pageObjectImports: string[] = [];
  const pageFixtureProps: string[] = [];
  const pageFixtureDefs: string[] = [];

  for (const step of stepNames) {
    const stepKebab = toKebabCase(step);
    const stepPascal = toPascalCase(step);
    const stepCamel = toCamelCase(step);
    const className = `${stepPascal}Page`;
    const propName = `${stepCamel}Page`;
    const pageFileName = `${stepKebab}.page.ts`;
    const pageFilePath = path.join(pagesDir, pageFileName);

    const pageContent = `
import { expect, type Locator, type Page } from '@playwright/test';

export class ${className} {
  readonly page: Page;
  readonly heading: Locator;
  // TODO: Add semantic readonly locators (getByRole > getByLabel > getByText > getByTestId), e.g.
  // readonly submitButton: Locator;

  constructor(page: Page) {
    this.page = page;
    // TODO: Replace with the page's real accessible heading.
    this.heading = page.getByRole('heading', { level: 1 });
    // this.submitButton = page.getByRole('button', { name: /submit|continue/i });
  }

  async goto() {
    // TODO: Confirm the route; relative URLs require use.baseURL in playwright.config.
    await this.page.goto('/${featureKebab}');
  }

  /** Web-first assertion that the page is ready for interaction. */
  async expectLoaded() {
    await expect(this.heading).toBeVisible();
  }

  // TODO: Add semantic action methods, e.g.
  // async submit() {
  //   await this.submitButton.click();
  // }
}
`;
    safeWriteFile(pageFilePath, pageContent);

    pageObjectImports.push(`import { ${className} } from './pages/${stepKebab}.page';`);
    pageFixtureProps.push(`  ${propName}: ${className};`);
    pageFixtureDefs.push(`  ${propName}: async ({ page }, use) => {\n    await use(new ${className}(page));\n  },`);
  }

  // 2. Generate Mock API Handler ({feature}.mock.ts)
  const mockClassName = `${featurePascal}Mock`;
  const mockPropName = `${featureCamel}Mock`;
  const mockFilePath = path.join(domainDir, `${featureKebab}.mock.ts`);
  const mockContent = `
import type { Page } from '@playwright/test';

/** Matches /api/v1/${featureKebab}, /api/v1/${featureKebab}/... and query strings. TODO: align with the real API. */
export const ${featureCamel}ApiPattern = /\\/api\\/v1\\/${featureKebab}(?:[/?#]|$)/;

export class ${mockClassName} {
  constructor(private readonly page: Page) {}

  /** Mock a successful response for the ${featurePascal} flow. */
  async mockSuccess(customData?: Record<string, unknown>) {
    await this.page.route(${featureCamel}ApiPattern, async (route) => {
      await route.fulfill({ status: 200, json: { success: true, message: 'Success', ...customData } });
    });
  }

  /** Mock an HTTP error (default 500) for error-flow UI tests. */
  async mockServerError(status = 500, message = 'Internal Server Error') {
    await this.page.route(${featureCamel}ApiPattern, async (route) => {
      await route.fulfill({ status, json: { success: false, message } });
    });
  }
}
`;
  safeWriteFile(mockFilePath, mockContent);

  // 3. Generate Real API Helper ({feature}.api.ts)
  const apiClassName = `${featurePascal}Api`;
  const apiPropName = `${featureCamel}Api`;
  const apiFilePath = path.join(domainDir, `${featureKebab}.api.ts`);
  const apiContent = `
import { expect, type APIRequestContext } from '@playwright/test';

/** Real backend calls for @integration tests. Relative URLs require use.baseURL in playwright.config. */
export class ${apiClassName} {
  constructor(private readonly request: APIRequestContext) {}

  /** TODO: Point at the real setup endpoint. */
  async setupState(payload: Record<string, unknown>) {
    const response = await this.request.post('/api/v1/${featureKebab}/setup', { data: payload });
    await expect(response).toBeOK();
    return response.json();
  }

  /** TODO: Point at the real cleanup endpoint. */
  async cleanupState(id: string) {
    const response = await this.request.delete(\`/api/v1/${featureKebab}/\${encodeURIComponent(id)}\`);
    await expect(response).toBeOK();
  }
}
`;
  safeWriteFile(apiFilePath, apiContent);

  // 4. Generate Custom Fixture ({feature}.fixture.ts)
  const fixtureFilePath = path.join(domainDir, `${featureKebab}.fixture.ts`);
  const fixtureContent = `
import { test as base, expect } from '../../support/diagnostics.fixture';
${pageObjectImports.join("\n")}
import { ${mockClassName} } from './${featureKebab}.mock';
import { ${apiClassName} } from './${featureKebab}.api';

type ${featurePascal}Fixtures = {
${pageFixtureProps.join("\n")}
  ${mockPropName}: ${mockClassName};
  ${apiPropName}: ${apiClassName};
};

export const test = base.extend<${featurePascal}Fixtures>({
${pageFixtureDefs.join("\n")}
  ${mockPropName}: async ({ page }, use) => {
    await use(new ${mockClassName}(page));
  },
  ${apiPropName}: async ({ request }, use) => {
    await use(new ${apiClassName}(request));
  },
});

export { expect };
`;
  safeWriteFile(fixtureFilePath, fixtureContent);

  // 5. Generate Data Factory (factory/{feature}.factory.ts)
  const factoryFilePath = path.join(factoryDir, `${featureKebab}.factory.ts`);
  const factoryContent = `
export interface ${featurePascal}Data {
  id: string;
  name: string;
  email: string;
  createdAt: number;
}

/**
 * Generate unique, dynamic data for ${featurePascal} tests. The random suffix keeps values unique
 * across parallel workers and re-runs, preventing unique-constraint collisions.
 */
export function create${featurePascal}Data(overrides?: Partial<${featurePascal}Data>): ${featurePascal}Data {
  const createdAt = Date.now();
  const unique = \`\${createdAt}-\${Math.random().toString(36).slice(2, 8)}\`;
  return {
    id: \`${featureKebab}_\${unique}\`,
    name: \`Test User \${unique}\`,
    email: \`${featureKebab}.\${unique}@example.com\`,
    createdAt,
    ...overrides,
  };
}
`;
  safeWriteFile(factoryFilePath, factoryContent);

  // 6. Generate Spec File (specs/{feature}.spec.ts)
  const firstPageProp = pageFixtureProps.length > 0 ? toCamelCase(stepNames[0]) + "Page" : "page";
  const specFilePath = path.join(specsDir, `${featureKebab}.spec.ts`);
  const specContent = `
// ${SKELETON_MARKER}: generated by scaffold_test_domain. Tests are test.fixme (skipped) until the TODOs
// are implemented with real actions and outcome assertions; then change test.fixme to test and
// remove this marker. score_test_quality reports the file as a skeleton while the marker is present.
import { test, expect } from '../domain/${featureKebab}/${featureKebab}.fixture';
import { create${featurePascal}Data } from '../factory/${featureKebab}.factory';

test.describe('${featurePascal} Flow', () => {
  test.fixme('should complete ${featureKebab} happy path @smoke @ui', async ({ ${firstPageProp}, ${mockPropName} }) => {
    const testData = create${featurePascal}Data();

    await test.step('Mock API responses', async () => {
      await ${mockPropName}.mockSuccess({ id: testData.id });
    });

    await test.step('Navigate to page', async () => {
      await ${firstPageProp}.goto();
      await ${firstPageProp}.expectLoaded();
    });

    await test.step('Interact with form and assert outcome', async () => {
      // TODO: Call page object actions and assert the user-visible outcome, e.g.
      // await ${firstPageProp}.submit();
      // await expect(${firstPageProp}.page.getByRole('status')).toHaveText(/success/i);
    });
  });

  test.fixme('should show an error when the API fails @ui', async ({ ${firstPageProp}, ${mockPropName} }) => {
    await test.step('Mock 500 server error', async () => {
      await ${mockPropName}.mockServerError(500);
    });

    await test.step('Navigate and trigger the request', async () => {
      await ${firstPageProp}.goto();
      await ${firstPageProp}.expectLoaded();
      // TODO: Perform the interaction that calls the API.
    });

    await test.step('Assert the error is shown', async () => {
      // TODO: Assert the user-visible error, e.g.
      // await expect(${firstPageProp}.page.getByRole('alert')).toContainText(/error/i);
    });
  });
});
`;
  safeWriteFile(specFilePath, specContent);

  return {
    feature: featureKebab,
    createdFiles,
    skippedFiles,
    domainDir: path.relative(root, domainDir),
    specFile: path.relative(root, specFilePath),
    factoryFile: path.relative(root, factoryFilePath),
    diagnosticsFixtureFile: path.relative(root, diagnosticsFixturePath),
    skeleton: true,
    nextSteps: [
      "Fill pages/*.page.ts with semantic locators and action methods (replace the TODOs).",
      "Align the mock route pattern and API endpoints with the real application.",
      `Implement the TODO steps in ${path.relative(root, specFilePath)}, then change test.fixme to test and remove the ${SKELETON_MARKER} marker.`,
      "Run score_test_quality (skeleton must be false) and then run_playwright_test.",
    ],
  };
}

/**
 * Auto fixture shared by all scaffolded domains. It records real browser events and attaches them
 * as `mcp-diagnostics` when a test does not end with its expected status, so run_playwright_test and
 * get_failure_details can report console errors, page errors and failed requests per test.
 */
const DIAGNOSTICS_FIXTURE_SOURCE = `
import { test as base, expect } from '@playwright/test';

const MAX_EVENTS = 20;
const MAX_TEXT = 500;

type ConsoleEntry = { type: string; text: string; location?: string };
type PageErrorEntry = { message: string; stack?: string };
type RequestEntry = { url: string; method: string; status?: number; failure?: string; resourceType: string };

export const test = base.extend<{ mcpDiagnostics: void }>({
  mcpDiagnostics: [
    async ({ page }, use, testInfo) => {
      const consoleMessages: ConsoleEntry[] = [];
      const pageErrors: PageErrorEntry[] = [];
      const failedRequests: RequestEntry[] = [];
      const push = <T>(list: T[], value: T) => {
        if (list.length < MAX_EVENTS) list.push(value);
      };

      page.on('console', (message) => {
        const type = message.type();
        if (type !== 'error' && type !== 'warning') return;
        const { url, lineNumber } = message.location();
        push(consoleMessages, { type, text: message.text().slice(0, MAX_TEXT), location: url ? \`\${url}:\${lineNumber}\` : undefined });
      });
      page.on('pageerror', (error) => {
        push(pageErrors, { message: error.message.slice(0, MAX_TEXT), stack: error.stack?.split('\\n').slice(0, 4).join('\\n') });
      });
      page.on('requestfailed', (request) => {
        push(failedRequests, { url: request.url(), method: request.method(), failure: request.failure()?.errorText, resourceType: request.resourceType() });
      });
      page.on('response', (response) => {
        if (response.status() < 400) return;
        const request = response.request();
        push(failedRequests, { url: response.url(), method: request.method(), status: response.status(), resourceType: request.resourceType() });
      });

      await use();

      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach('mcp-diagnostics', {
          body: JSON.stringify({ consoleMessages, pageErrors, failedRequests }),
          contentType: 'application/json',
        });
      }
    },
    { auto: true },
  ],
});

export { expect };
`;
