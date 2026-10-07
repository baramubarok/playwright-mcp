import { z } from "zod";

/**
 * MCP output schemas (tools/list `outputSchema`). Nested objects use passthrough so additive fields
 * stay backward compatible; the fields listed here are the contract clients can rely on.
 */

const location = z.object({ file: z.string().optional(), line: z.number().optional(), column: z.number().optional() }).passthrough();

const networkError = z
  .object({
    url: z.string().optional(),
    method: z.string().optional(),
    status: z.number().optional(),
    message: z.string().optional(),
    source: z.enum(["browser", "error_message"]).optional(),
  })
  .passthrough();

export const failureDetailSchema = z
  .object({
    testId: z.string().optional(),
    testTitle: z.string(),
    fullTitle: z.string().optional(),
    projectName: z.string().optional(),
    errorType: z.enum(["locator_not_found", "timeout", "assertion_failed", "network", "unknown"]),
    errorMessage: z.string(),
    location: location.optional(),
    screenshotPath: z.string().optional(),
    traceZipPath: z.string().optional(),
    videoPath: z.string().optional(),
    errorContextPath: z.string().optional(),
    recentSteps: z.array(z.string()).optional(),
    consoleErrors: z.array(z.string()).optional(),
    pageErrors: z.array(z.string()).optional(),
    networkErrors: z.array(networkError).optional(),
    diagnosticsSources: z.array(z.enum(["trace", "fixture"])).optional(),
    diagnosticsOmitted: z.object({ consoleMessages: z.number(), pageErrors: z.number(), failedRequests: z.number() }).optional(),
    callLogExcerpt: z.string().optional(),
    healingGateDirective: z.string().optional(),
  })
  .passthrough();

const suiteStatus = z.enum(["passed", "failed", "timedout", "interrupted", "flaky", "skipped", "runner_error", "setup_required"]);
const testStatus = z.enum(["passed", "failed", "timedout", "interrupted", "flaky", "skipped"]);

export const runPlaywrightTestOutputShape = {
  status: suiteStatus,
  detail: z.enum(["summary", "full"]),
  projectRoot: z.string(),
  durationMs: z.number(),
  summary: z.object({
    total: z.number(),
    passed: z.number(),
    failed: z.number(),
    timedout: z.number(),
    interrupted: z.number(),
    flaky: z.number(),
    skipped: z.number(),
  }),
  runnerError: z
    .object({
      kind: z.enum(["spawn_error", "process_failure", "timeout", "cancelled", "report_error", "report_missing", "report_malformed", "empty_suite"]),
      message: z.string(),
    })
    .optional(),
  failures: z.array(failureDetailSchema).optional(),
  failuresOmitted: z.number().optional(),
  tests: z.array(
    z
      .object({
        testId: z.string(),
        title: z.string(),
        fullTitle: z.string().optional(),
        projectName: z.string().optional(),
        status: testStatus,
        durationMs: z.number(),
        retries: z.number(),
        errorType: z.string().optional(),
      })
      .passthrough(),
  ),
  testsOmitted: z.number().optional(),
  runner: z
    .object({
      exitCode: z.number().nullable(),
      signal: z.string().nullable(),
      timedOut: z.boolean(),
      cancelled: z.boolean(),
      durationMs: z.number(),
      timeoutMs: z.number(),
      reporterStrategy: z.enum(["config_wrapper", "cli_override"]),
      preservedReporters: z.array(z.string()).optional(),
    })
    .passthrough()
    .optional(),
  reportPath: z.string().optional(),
  traceZipPath: z.string().optional(),
  videoPath: z.string().optional(),
  nativeReports: z.object({ htmlReportPath: z.string().optional(), allureResultsPath: z.string().optional() }).optional(),
  qualityScore: z.object({}).passthrough().optional(),
  qualityReportHtmlPath: z.string().optional(),
  healingGateDirective: z.string().optional(),
  reportPromptDirective: z.string().optional(),
  prerequisites: z.object({}).passthrough().optional(),
  outputBudget: z.object({ maxChars: z.number(), reduced: z.boolean() }).optional(),
};

export const getFailureDetailsOutputShape = failureDetailSchema.shape;

const scoreShape = {
  locatorQuality: z.object({ semanticPct: z.number(), cssXpathCount: z.number(), semanticCount: z.number(), totalLocators: z.number() }),
  assertionDensity: z.object({ totalAssertions: z.number(), testCount: z.number(), perTestAvg: z.number() }),
  antiPatterns: z.record(z.number()),
  scaffold: z.object({ skeleton: z.boolean(), todoCount: z.number(), fixmeTests: z.number() }),
  warnings: z.array(z.string()),
};

export const scoreTestQualityOutputShape = {
  ...scoreShape,
  fileBreakdown: z.record(z.object(scoreShape).passthrough()).optional(),
  qualityReportHtmlPath: z.string().optional(),
};

const configSetting = z
  .object({
    value: z.string().optional(),
    kind: z.enum(["literal", "expression", "missing"]),
    line: z.number().optional(),
  })
  .passthrough();

export const checkPlaywrightConfigOutputShape = {
  configPath: z.string().nullable(),
  found: z.boolean(),
  analysis: z.enum(["ast", "text_scan", "none"]),
  settings: z.record(z.string().optional()),
  settingDetails: z.record(configSetting).optional(),
  reporters: z
    .object({
      detected: z.array(z.string()),
      html: z.boolean(),
      json: z.boolean(),
      allure: z.boolean(),
      determinable: z.boolean(),
    })
    .optional(),
  warnings: z.array(z.string()),
  limitations: z.array(z.string()).optional(),
  note: z.string(),
};

export const generateTestReportOutputShape = {
  reporter: z.enum(["quality", "html", "allure"]),
  mode: z.enum(["locate", "generate"]),
  status: z.enum(["located", "generated", "not_found", "setup_required", "generation_failed"]),
  reportPath: z.string().optional(),
  exists: z.boolean(),
  message: z.string(),
  commandToOpen: z.string().optional(),
  generator: z
    .object({
      command: z.string(),
      exitCode: z.number().nullable(),
      signal: z.string().nullable(),
      timedOut: z.boolean(),
      durationMs: z.number(),
      stderrTail: z.string().optional(),
    })
    .optional(),
};

export const scaffoldTestDomainOutputShape = {
  feature: z.string(),
  createdFiles: z.array(z.string()),
  skippedFiles: z.array(z.string()),
  domainDir: z.string(),
  specFile: z.string(),
  factoryFile: z.string(),
  diagnosticsFixtureFile: z.string(),
  skeleton: z.literal(true),
  nextSteps: z.array(z.string()),
};

export const checkTestPrerequisitesOutputShape = {
  projectRoot: z.string(),
  workspaceRoot: z.string().optional(),
  packageJsonFound: z.boolean(),
  playwright: z
    .object({
      packageInstalled: z.boolean(),
      cliAvailable: z.boolean(),
      configFound: z.boolean(),
      ready: z.boolean(),
      status: z.enum(["ready", "setup_required"]),
      browsers: z.object({ status: z.enum(["installed", "outdated", "missing", "unknown"]) }).passthrough(),
    })
    .passthrough(),
  allure: z.object({ status: z.enum(["ready", "not_configured", "setup_required", "results_missing"]) }).passthrough(),
  nextSteps: z.array(z.string()),
  warnings: z.array(z.string()),
};

export const setProjectRootOutputShape = {
  projectRoot: z.string(),
  message: z.string(),
};

export const toolErrorShape = {
  error: z.object({ code: z.string(), message: z.string(), details: z.record(z.unknown()).optional() }),
};
