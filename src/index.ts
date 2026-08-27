#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { runPlaywrightTest, runPlaywrightTestInputShape } from "./tools/runPlaywrightTest.js";
import { getFailureDetails, getFailureDetailsInputShape } from "./tools/getFailureDetails.js";
import { scoreTestQuality, scoreTestQualityInputShape } from "./tools/scoreTestQuality.js";
import { checkPlaywrightConfig, checkPlaywrightConfigInputShape } from "./tools/checkPlaywrightConfig.js";
import { WORKFLOW_GUIDE_PROMPT_NAME, workflowGuideText } from "./prompts/workflowGuide.js";
import { setProjectRoot } from "./lib/config.js";
import { z } from "zod";

function asJsonToolResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function asErrorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

const server = new McpServer({
  name: "playwright-generate-mcp",
  version: "1.0.0",
});

server.registerTool(
  "set_project_root",
  {
    title: "Set project root",
    description:
      "Explicitly set the target project root directory. Use this as a fallback if playwright.config.* cannot be automatically discovered by other tools.",
    inputSchema: {
      projectRoot: z.string().describe("Absolute path to the target project root, e.g. \"/home/user/my-app\"."),
    },
  },
  async (input) => {
    try {
      const resolved = setProjectRoot(input.projectRoot);
      return asJsonToolResult({ projectRoot: resolved, message: `PROJECT_ROOT set to ${resolved}` });
    } catch (error) {
      return asErrorResult(error);
    }
  }
);

server.registerTool(
  "run_playwright_test",
  {
    title: "Run Playwright test",
    description:
      "Run a Playwright spec file in the target project and return structured pass/fail results with immediate inline failure diagnostics (location, error type, steps, console errors, network errors, screenshots) and a comprehensive qualityScore. " +
      "REPORTING INSTRUCTION: You MUST ALWAYS render a concise 'Playwright Test Quality Score' Markdown table in your user-facing response based on 'qualityScore' (displaying % semantic locators, total assertions, anti-patterns, and any specific warnings in Page Objects / Specs) so the user is immediately aware of locator and code health. " +
      "If tests fail, analyze the error and formulate a concrete fix proposal. " +
      "To confirm with the user before applying fixes: " +
      "1) If an interactive question/selection tool is available in your environment (e.g. ask_question, vscode_askQuestions), MUST use it to present options: ['Apply Fix & Re-run', 'Review Diff First', 'Cancel']. " +
      "2) Otherwise, present the options as a clean numbered list in your response so the user can easily reply with just the number.",
    inputSchema: runPlaywrightTestInputShape,
  },
  async (input) => {
    try {
      return asJsonToolResult(await runPlaywrightTest(input));
    } catch (error) {
      return asErrorResult(error);
    }
  }
);

server.registerTool(
  "get_failure_details",
  {
    title: "Get failure details",
    description:
      "Get detailed diagnostic breakdown (exact failure location, 3–5 recent steps before error, console errors, network failures, screenshot/trace paths, call log) for a specific failing test from a previous run_playwright_test report.",
    inputSchema: getFailureDetailsInputShape,
  },
  async (input) => {
    try {
      return asJsonToolResult(getFailureDetails(input));
    } catch (error) {
      return asErrorResult(error);
    }
  }
);

server.registerTool(
  "score_test_quality",
  {
    title: "Score test quality",
    description:
      "Score a spec file and its imported Page Objects on measurable quality signals: % semantic locators vs raw CSS/XPath, assertion density, and specific anti-pattern warnings with line numbers across all related files. Render the resulting scores as a markdown table in your response.",
    inputSchema: scoreTestQualityInputShape,
  },
  async (input) => {
    try {
      return asJsonToolResult(scoreTestQuality(input));
    } catch (error) {
      return asErrorResult(error);
    }
  }
);

server.registerTool(
  "check_playwright_config",
  {
    title: "Check Playwright config",
    description:
      "Heuristically check playwright.config.* for flakiness-relevant settings (retries, trace, screenshot, forbidOnly, fullyParallel) and warn on risky defaults. Project-level, not per-spec.",
    inputSchema: checkPlaywrightConfigInputShape,
  },
  async (input) => {
    try {
      return asJsonToolResult(checkPlaywrightConfig(input));
    } catch (error) {
      return asErrorResult(error);
    }
  }
);

server.registerPrompt(
  WORKFLOW_GUIDE_PROMPT_NAME,
  {
    title: "Playwright E2E workflow guide",
    description: "Step-by-step workflow for generating, running, diagnosing, and safely healing Playwright E2E tests with this server's tools.",
  },
  async () => ({
    messages: [
      {
        role: "user" as const,
        content: { type: "text" as const, text: workflowGuideText },
      },
    ],
  })
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Fatal error starting playwright-generate-mcp:", error);
  process.exit(1);
});
