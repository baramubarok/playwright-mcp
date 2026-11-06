import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { findProjectRoot } from "../lib/config.js";
import { resolveProjectPath } from "../lib/pathSecurity.js";
import { SKELETON_MARKER } from "../lib/scoreContent.js";
import { urlPathSchema } from "../lib/urlPath.js";
import { ASSET_HELPER_SOURCE, SELECTORS_HELPER_SOURCE } from "../templates/qaProject.js";
import { DIAGNOSTICS_FIXTURE_SOURCE } from "../templates/diagnosticsFixture.js";
import {
  ALL_TEST_TYPES,
  apiSource,
  buildHelperCatalog,
  factorySource,
  fixtureSource,
  mockSource,
  pageSource,
  specSource,
  type DomainContext,
  type HelperCatalogEntry,
  type Names,
  type TestType,
} from "../templates/domain.js";
import { scaffoldAuthSetup, type ScaffoldAuthSetupOutput } from "./scaffoldAuthSetup.js";
import {
  assertSafeIdentifier,
  assertUniqueNormalizedIdentifiers,
  safeIdentifierSchema,
} from "../lib/safeIdentifier.js";

export { DIAGNOSTICS_FIXTURE_SOURCE };

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
  testTypes: z
    .array(z.enum(["smoke", "ui", "regression", "integration"]))
    .optional()
    .describe("Which reference example tests to put in the spec. Default: all four (smoke, ui, regression, integration)."),
  apiBasePath: urlPathSchema
    .optional()
    .describe("API path of the feature used by the mock and api helpers, e.g. \"/api/v1/orders\". Default: /api/v1/{featureName}."),
  withAuthSetup: z
    .boolean()
    .optional()
    .describe(
      "For auth-like features (name contains auth, login, logout, register, signin or signup) also create the global auth handler (scaffold_auth_setup, UI mode). Default: true. Pass false to skip.",
    ),
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
  /** True when the feature name looks like authentication; its spec starts logged out. */
  authFeature: boolean;
  /** Result of the automatic global auth handler scaffold (auth-like features only). */
  authSetup?: ScaffoldAuthSetupOutput;
  /** Everything specs can call (fixtures, page locators/methods, mock/api methods, factories, support helpers). */
  helperCatalog: HelperCatalogEntry[];
  nextSteps: string[];
}

const AUTH_FEATURE_PATTERN = /auth|login|logout|register|sign-?in|sign-?up/i;

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

function namesOf(value: string): Names {
  return { kebab: toKebabCase(value), pascal: toPascalCase(value), camel: toCamelCase(value) };
}

export function scaffoldTestDomain(input: ScaffoldTestDomainInput): ScaffoldTestDomainOutput {
  assertSafeIdentifier(input.featureName, "featureName");
  const requestedStepNames = input.steps && input.steps.length > 0 ? input.steps : undefined;
  for (const [index, step] of (requestedStepNames ?? []).entries()) {
    assertSafeIdentifier(step, `steps[${index}]`);
  }

  const root = findProjectRoot(undefined, input.projectRoot);
  const feature = namesOf(input.featureName);

  const stepNames = requestedStepNames ?? [feature.kebab];
  assertUniqueNormalizedIdentifiers(stepNames, "steps", toKebabCase);

  const authFeature = AUTH_FEATURE_PATTERN.test(input.featureName);
  const requestedTypes = new Set<TestType>(input.testTypes && input.testTypes.length > 0 ? input.testTypes : ALL_TEST_TYPES);
  const ctx: DomainContext = {
    feature,
    steps: stepNames.map(namesOf),
    apiBasePath: input.apiBasePath ?? `/api/v1/${feature.kebab}`,
    testTypes: ALL_TEST_TYPES.filter((type) => requestedTypes.has(type)),
    authFeature,
  };

  const baseE2eDir = path.join(root, "tests", "e2e");
  const domainDir = path.join(baseE2eDir, "domain", feature.kebab);
  const pagesDir = path.join(domainDir, "pages");
  const factoryDir = path.join(baseE2eDir, "factory");
  const specsDir = path.join(baseE2eDir, "specs");
  const supportDir = path.join(baseE2eDir, "support");

  const sharedFiles = [
    { filePath: path.join(supportDir, "diagnostics.fixture.ts"), content: DIAGNOSTICS_FIXTURE_SOURCE },
    { filePath: path.join(supportDir, "selectors.ts"), content: SELECTORS_HELPER_SOURCE },
    { filePath: path.join(supportDir, "assets.ts"), content: ASSET_HELPER_SOURCE },
  ];
  const diagnosticsFixturePath = sharedFiles[0].filePath;
  const factoryFilePath = path.join(factoryDir, `${feature.kebab}.factory.ts`);
  const specFilePath = path.join(specsDir, `${feature.kebab}.spec.ts`);

  const domainFiles = [
    ...ctx.steps.map((step) => ({ filePath: path.join(pagesDir, `${step.kebab}.page.ts`), content: pageSource(ctx, step) })),
    { filePath: path.join(domainDir, `${feature.kebab}.mock.ts`), content: mockSource(ctx) },
    { filePath: path.join(domainDir, `${feature.kebab}.api.ts`), content: apiSource(ctx) },
    { filePath: path.join(domainDir, `${feature.kebab}.fixture.ts`), content: fixtureSource(ctx) },
    { filePath: factoryFilePath, content: factorySource(ctx) },
    { filePath: specFilePath, content: specSource(ctx) },
  ];

  const destinationDirs = [pagesDir, factoryDir, specsDir, supportDir];

  // Preflight every destination before creating any directory or file.
  for (const directory of destinationDirs) {
    resolveProjectPath(directory, root, { forWrite: true });
  }
  for (const { filePath } of [...sharedFiles, ...domainFiles]) {
    resolveProjectPath(filePath, root, { forWrite: true });
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

  for (const file of sharedFiles) safeWriteFile(file.filePath, file.content, { shared: true });
  for (const file of domainFiles) safeWriteFile(file.filePath, file.content);

  const authSetup = authFeature && input.withAuthSetup !== false ? scaffoldAuthSetup({ projectRoot: root, mode: "ui", overwrite: false }) : undefined;

  return {
    feature: feature.kebab,
    createdFiles,
    skippedFiles,
    domainDir: path.relative(root, domainDir),
    specFile: path.relative(root, specFilePath),
    factoryFile: path.relative(root, factoryFilePath),
    diagnosticsFixtureFile: path.relative(root, diagnosticsFixturePath),
    skeleton: true,
    authFeature,
    ...(authSetup ? { authSetup } : {}),
    helperCatalog: buildHelperCatalog(ctx, (suffix) => path.join(path.relative(root, domainDir), suffix).split(path.sep).join("/")),
    nextSteps: [
      "Scrape the real page first (inspect_page) and replace the reference locators in pages/*.page.ts (data-testid > data-qa > data-{ID_SELECTOR} > semantic).",
      `Align ${ctx.apiBasePath} in the mock/api files and the payload type with the real API; reuse helperCatalog instead of re-reading the files.`,
      `Adapt the reference tests in ${path.relative(root, specFilePath)} to the test case, using only the page/mock/api fixtures (add missing methods to those files, never inline request.* or page.route() in the spec).`,
      `Then change test.fixme to test and remove the ${SKELETON_MARKER} marker.`,
      "Run score_test_quality (skeleton must be false, no inlineApiCall/inlineRoute) and then run_playwright_test.",
      ...(authSetup ? ["A global auth handler was scaffolded under tests/e2e/auth; follow authSetup.nextSteps (credentials in .env, login form locators)."] : []),
    ],
  };
}
