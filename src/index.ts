#!/usr/bin/env node
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z, type ZodRawShape } from "zod";
import { runPlaywrightTest, runPlaywrightTestInputShape, type RunPlaywrightTestOutput } from "./tools/runPlaywrightTest.js";
import { getFailureDetails, getFailureDetailsInputShape } from "./tools/getFailureDetails.js";
import { scoreTestQuality, scoreTestQualityInputShape } from "./tools/scoreTestQuality.js";
import { checkPlaywrightConfig, checkPlaywrightConfigInputShape } from "./tools/checkPlaywrightConfig.js";
import { generateTestReport, generateTestReportInputShape } from "./tools/generateTestReport.js";
import { scaffoldTestDomain, scaffoldTestDomainInputShape } from "./tools/scaffoldTestDomain.js";
import { initQaProject, initQaProjectInputShape } from "./tools/initQaProject.js";
import { scaffoldAuthSetup, scaffoldAuthSetupInputShape } from "./tools/scaffoldAuthSetup.js";
import { readTestCases, readTestCasesInputShape } from "./tools/readTestCases.js";
import { checkTestPrerequisitesTool, checkTestPrerequisitesInputShape } from "./tools/checkTestPrerequisites.js";
import { WRITE_TEST_PROMPT_NAME, writeTestPromptText } from "./prompts/writeTestPrompt.js";
import { RUN_AND_HEAL_PROMPT_NAME, runAndHealPromptText } from "./prompts/runAndHealPrompt.js";
import { setProjectRoot } from "./lib/config.js";
import { toToolErrorPayload } from "./lib/toolErrors.js";
import { terminateActiveRunners } from "./lib/runnerProcess.js";
import { cleanupRunConfigs } from "./lib/runConfig.js";
import { cleanupRunReports } from "./lib/reportRegistry.js";
import {
  checkPlaywrightConfigOutputShape,
  checkTestPrerequisitesOutputShape,
  generateTestReportOutputShape,
  getFailureDetailsOutputShape,
  initQaProjectOutputShape,
  readTestCasesOutputShape,
  runPlaywrightTestOutputShape,
  scaffoldAuthSetupOutputShape,
  scaffoldTestDomainOutputShape,
  scoreTestQualityOutputShape,
  setProjectRootOutputShape,
} from "./lib/outputSchemas.js";

const packageJson = createRequire(import.meta.url)("../package.json") as { version: string };

/**
 * Successful results carry the typed payload twice by design: `structuredContent` for clients that
 * validate the output schema, and a one-line summary plus compact JSON text for clients that only
 * forward text content to the model (MCP backwards-compatibility guidance).
 */
function asJsonToolResult(data: object, summary?: string) {
  const json = JSON.stringify(data);
  return {
    content: [{ type: "text" as const, text: summary ? `${summary}\n${json}` : json }],
    structuredContent: data as Record<string, unknown>,
  };
}

function asErrorResult(error: unknown) {
  const payload = toToolErrorPayload(error);
  return {
    content: [{ type: "text" as const, text: `Error [${payload.code}]: ${payload.message}\n${JSON.stringify({ error: payload })}` }],
    structuredContent: { error: payload },
    isError: true,
  };
}

function summarizeRun(result: RunPlaywrightTestOutput): string {
  const { summary } = result;
  const seconds = (result.durationMs / 1000).toFixed(1);
  const failing = summary.failed + summary.timedout + summary.interrupted;
  const parts = [`status=${result.status}`, `${summary.total} tests`, `${summary.passed} passed`];
  if (failing > 0) parts.push(`${failing} failed`);
  if (summary.flaky > 0) parts.push(`${summary.flaky} flaky`);
  if (summary.skipped > 0) parts.push(`${summary.skipped} skipped`);
  parts.push(`${seconds}s`);
  if (result.runnerError) parts.push(`runnerError=${result.runnerError.kind}`);
  return parts.join(" · ");
}

const server = new McpServer({
  name: "playwright-generate-mcp",
  version: packageJson.version,
});

type ToolExtra = { signal: AbortSignal };

function registerJsonTool<InputShape extends ZodRawShape, OutputShape extends ZodRawShape, Result extends object>(
  name: string,
  config: { title: string; description: string; inputSchema: InputShape; outputSchema: OutputShape },
  handler: (input: z.objectOutputType<InputShape, z.ZodTypeAny>, extra: ToolExtra) => Result | Promise<Result>,
  summarize?: (result: Result) => string,
): void {
  server.registerTool(name, config, (async (input: z.objectOutputType<InputShape, z.ZodTypeAny>, extra: ToolExtra) => {
    try {
      const result = await handler(input, extra);
      return asJsonToolResult(result, summarize?.(result));
    } catch (error) {
      return asErrorResult(error);
    }
  }) as never);
}

registerJsonTool(
  "set_project_root",
  {
    title: "Set project root",
    description:
      "Explicitly set the target project root directory. Use this as a fallback if playwright.config.* cannot be automatically discovered by other tools.",
    inputSchema: {
      projectRoot: z.string().describe("Absolute path to the target project root, e.g. \"/home/user/my-app\"."),
    },
    outputSchema: setProjectRootOutputShape,
  },
  (input) => {
    const resolved = setProjectRoot(input.projectRoot);
    return { projectRoot: resolved, message: `PROJECT_ROOT set to ${resolved}` };
  },
);

registerJsonTool(
  "init_qa_project",
  {
    title: "Initialize QA automation project",
    description:
      "Create a standalone Playwright automation repository for QA (separate from the frontend repo): package.json, playwright.config.ts, tsconfig, .env/.env.example (BASE_URL, API_URL, ID_SELECTOR, TEST_USER, TEST_PASSWORD), .gitignore, docs/test-case/ (test case files) and assets/ (files for uploads), plus tests/e2e/support helpers. " +
      "Existing files are skipped unless overwrite is true, and .env is never overwritten. The new project becomes the active project root.",
    inputSchema: initQaProjectInputShape,
    outputSchema: initQaProjectOutputShape,
  },
  (input) => {
    const result = initQaProject(input);
    setProjectRoot(result.projectRoot);
    return result;
  },
  (result) => `Initialized QA project at ${result.projectRoot}: ${result.createdFiles.length} created, ${result.skippedFiles.length} skipped.`,
);

registerJsonTool(
  "read_test_cases",
  {
    title: "Read QA test cases",
    description:
      "Read the test case files QA put in docs/test-case/ (Gherkin .feature, .csv, optional .xlsx) and return structured cases: id, title, feature, priority, tags, preconditions, steps, expected results, with source file and line/row. " +
      "Read-only and limited to docs/test-case/. Use it BEFORE inspecting the website and generating tests; keep the case id (e.g. TC-001) as a tag in the generated test title. Filter with ids or path to save tokens.",
    inputSchema: readTestCasesInputShape,
    outputSchema: readTestCasesOutputShape,
  },
  (input) => readTestCases(input),
  (result) => `${result.totalCases} test case(s) from ${result.files.length} file(s)${result.warnings.length > 0 ? ` · ${result.warnings.length} warning(s)` : ""}`,
);

registerJsonTool(
  "scaffold_auth_setup",
  {
    title: "Scaffold global auth setup",
    description:
      "Create the global authentication handler: tests/e2e/auth (config, page object or API helper, auth.setup.ts) that logs in once with TEST_USER/TEST_PASSWORD from .env and saves the session to .auth/user.json, then wires a 'setup' project with storageState and dependencies into playwright.config.* (when it is the standard QA config) and git-ignores .auth/. " +
      "mode 'ui' (default) logs in through the form; mode 'api' logs in with the backend API. scaffold_test_domain calls this automatically for auth-like features.",
    inputSchema: scaffoldAuthSetupInputShape,
    outputSchema: scaffoldAuthSetupOutputShape,
  },
  (input) => scaffoldAuthSetup(input),
  (result) => `Auth setup (${result.mode}): ${result.createdFiles.length} created, ${result.skippedFiles.length} skipped, config ${result.configStatus}.`,
);

registerJsonTool(
  "scaffold_test_domain",
  {
    title: "Scaffold test domain",
    description:
      "Scaffold the Domain-Driven POM structure for a feature: pages, mock API handlers, real API helpers, custom fixture, dynamic data factory and a spec, plus a shared diagnostics fixture (tests/e2e/support) that records browser console/page/network events. " +
      "The spec is an explicit skeleton: its tests are test.fixme (skipped) and marked @mcp-skeleton until the TODOs are implemented. Always use this before writing new tests to ensure a consistent structure.",
    inputSchema: scaffoldTestDomainInputShape,
    outputSchema: scaffoldTestDomainOutputShape,
  },
  (input) => scaffoldTestDomain(input),
  (result) => `Scaffolded ${result.feature}: ${result.createdFiles.length} created, ${result.skippedFiles.length} skipped (skeleton — implement TODOs, then test.fixme → test).`,
);

registerJsonTool(
  "run_playwright_test",
  {
    title: "Run Playwright test",
    description:
      "Run Playwright tests in the target project (pass a spec file, a directory, or omit specPath and pass grep for tag-only runs like @smoke or @regression) and return a bounded, structured result: explicit status, counts, runner/process metadata, up to 5 failures with location, error type, recent steps, " +
      "browser console errors, page errors and failed requests (from trace.zip and/or the scaffolded diagnostics fixture), screenshot/trace/video/error-context paths, and a compact qualityScore. " +
      "The project's own reporters keep running, and Allure reports (allure-report/index.html) are automatically compiled when Allure is configured in the project. Use detail:'full' or get_failure_details for more. " +
      "TOKEN ECONOMY INSTRUCTION: In your response, provide a clean, compact 2–3 line summary (status, duration, video link, and failure cause) rather than dumping large markdown tables into chat. " +
      "If tests fail, analyze the error and formulate a concrete fix proposal in '.page.ts'. " +
      "To confirm with the user before applying fixes: " +
      "1) If an interactive question/selection tool is available in your environment (e.g. ask_question, vscode_askQuestions), MUST use it to present options: ['Apply Fix & Re-run', 'Review Diff First', 'Cancel']. " +
      "2) Otherwise, present the options as a clean numbered list in your response so the user can easily reply with just the number.",
    inputSchema: runPlaywrightTestInputShape,
    outputSchema: runPlaywrightTestOutputShape,
  },
  (input, extra) => runPlaywrightTest(input, { signal: extra.signal }),
  summarizeRun,
);

registerJsonTool(
  "check_test_prerequisites",
  {
    title: "Check test prerequisites",
    description:
      "Read-only preflight check for a target project. Detects the local (or workspace-hoisted) Playwright package, CLI, config, browser builds matching the installed Playwright version, branded channels, optional Allure adapter/CLI readiness and setup guide, and report artifacts — without installing packages or downloading browsers.",
    inputSchema: checkTestPrerequisitesInputShape,
    outputSchema: checkTestPrerequisitesOutputShape,
  },
  (input) => checkTestPrerequisitesTool(input),
  (result) => `playwright=${result.playwright.status} · browsers=${result.playwright.browsers.status} · allure=${result.allure.status}`,
);

registerJsonTool(
  "get_failure_details",
  {
    title: "Get failure details",
    description:
      "Get the full diagnostic breakdown for one failing test from a previous run_playwright_test report: exact location, recent steps, call log, browser console errors, page errors, failed requests, and screenshot/trace/video/error-context paths. Pass testId when titles repeat (e.g. the same spec in several projects).",
    inputSchema: getFailureDetailsInputShape,
    outputSchema: getFailureDetailsOutputShape,
  },
  (input) => getFailureDetails(input),
  (result) => `${result.errorType} in "${result.testTitle}"${result.location?.line ? ` at line ${result.location.line}` : ""}`,
);

registerJsonTool(
  "score_test_quality",
  {
    title: "Score test quality",
    description:
      "Score a spec file and its imported Page Objects with the TypeScript AST (comments and strings are ignored): % semantic locators vs raw CSS/XPath, assertion density, anti-pattern warnings with line numbers, and scaffold skeleton status.",
    inputSchema: scoreTestQualityInputShape,
    outputSchema: scoreTestQualityOutputShape,
  },
  (input) => scoreTestQuality(input),
  (result) =>
    `semantic=${result.locatorQuality.semanticPct}% · assertions/test=${result.assertionDensity.perTestAvg} · warnings=${result.warnings.length}${result.scaffold.skeleton ? " · skeleton" : ""}`,
);

registerJsonTool(
  "check_playwright_config",
  {
    title: "Check Playwright config",
    description:
      "Statically analyze playwright.config.* (TypeScript AST, not executed) for flakiness-relevant settings (retries, workers, trace, screenshot, video, forbidOnly, fullyParallel) and reporters (HTML/JSON/Allure). Reports whether each value is a literal or a runtime expression. Project-level, not per-spec.",
    inputSchema: checkPlaywrightConfigInputShape,
    outputSchema: checkPlaywrightConfigOutputShape,
  },
  (input) => checkPlaywrightConfig(input),
  (result) => (result.found ? `${result.configPath}: ${result.warnings.length} warning(s)` : "No Playwright config found"),
);

registerJsonTool(
  "generate_test_report",
  {
    title: "Generate test report",
    description:
      "Locate or generate a visual test report. 'quality' and 'html' locate existing reports (the quality dashboard at test-results/quality-report.html; the Playwright HTML report written by the project's html reporter). " +
      "'allure' generates allure-report/ from allure-results/ with the local Allure CLI (never downloaded). Returns status: located | generated | not_found | setup_required | generation_failed.",
    inputSchema: generateTestReportInputShape,
    outputSchema: generateTestReportOutputShape,
  },
  (input, extra) => generateTestReport(input, { signal: extra.signal }),
  (result) => `${result.reporter}: ${result.status}`,
);

server.registerPrompt(
  WRITE_TEST_PROMPT_NAME,
  {
    title: "Playwright: Write new test",
    description: "Workflow for scaffolding and writing enterprise-grade Domain-Driven POM tests using scaffold_test_domain, semantic locators, mock/api helpers, and dynamic factories.",
  },
  async () => ({
    messages: [
      {
        role: "user" as const,
        content: { type: "text" as const, text: writeTestPromptText },
      },
    ],
  })
);

server.registerPrompt(
  RUN_AND_HEAL_PROMPT_NAME,
  {
    title: "Playwright: Run and auto-heal test",
    description: "Focused workflow for executing Playwright tests, interpreting single-turn failure diagnostics & video recordings, and safely auto-healing selectors in Page Objects.",
  },
  async () => ({
    messages: [
      {
        role: "user" as const,
        content: { type: "text" as const, text: runAndHealPromptText },
      },
    ],
  })
);

/** Synchronous cleanup: runner process groups are detached, so they must be killed explicitly. */
function releaseResources(): void {
  terminateActiveRunners("SIGKILL");
  cleanupRunConfigs();
  cleanupRunReports();
}

let shuttingDown = false;
function shutdown(exitCode = 0): void {
  if (shuttingDown) return;
  shuttingDown = true;
  releaseResources();
  process.exit(exitCode);
}

async function main() {
  process.once("exit", releaseResources);
  process.once("SIGINT", () => shutdown(130));
  process.once("SIGTERM", () => shutdown(143));
  // The client closing stdin ends the session; do not leave Playwright or browsers running.
  process.stdin.once("end", () => shutdown(0));
  process.stdin.once("close", () => shutdown(0));

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Fatal error starting playwright-generate-mcp:", error);
  process.exit(1);
});
