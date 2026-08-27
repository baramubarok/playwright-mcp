import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { findProjectRoot, resolveInProjectRoot } from "../lib/config.js";

export const checkPlaywrightConfigInputShape = {
  configPath: z
    .string()
    .optional()
    .describe("Path to playwright.config.* relative to project root or absolute. If omitted, auto-detected at project root."),
  projectRoot: z
    .string()
    .optional()
    .describe("Optional path to the project root. If omitted, auto-detected."),
};

export const checkPlaywrightConfigSchema = z.object(checkPlaywrightConfigInputShape);
export type CheckPlaywrightConfigInput = z.infer<typeof checkPlaywrightConfigSchema>;

export interface CheckPlaywrightConfigOutput {
  configPath: string | null;
  found: boolean;
  settings: {
    retries?: string;
    workers?: string;
    fullyParallel?: string;
    forbidOnly?: string;
    trace?: string;
    screenshot?: string;
    video?: string;
  };
  warnings: string[];
  note: string;
}

const CANDIDATE_FILENAMES = [
  "playwright.config.ts",
  "playwright.config.js",
  "playwright.config.mjs",
  "playwright.config.cjs",
  "playwright.config.mts",
  "playwright.config.cts",
];

const NOTE =
  "This check is a heuristic text scan of the config file, not a full evaluation — it can miss settings " +
  "assigned via variables, spread, or environment-dependent expressions.";

function extractSetting(content: string, key: string): string | undefined {
  const re = new RegExp(`\\b${key}\\s*:\\s*([^,\\n}]+)`);
  const match = content.match(re);
  return match ? match[1].trim() : undefined;
}

export function checkPlaywrightConfig(input: CheckPlaywrightConfigInput): CheckPlaywrightConfigOutput {
  let relativeOrAbsolutePath: string | null = null;
  let root: string;

  try {
    root = findProjectRoot(input.configPath, input.projectRoot);
  } catch {
    return {
      configPath: null,
      found: false,
      settings: {},
      warnings: [
        "Playwright configuration (playwright.config.*) could not be located. Provide 'projectRoot' or run 'set_project_root'.",
      ],
      note: NOTE,
    };
  }

  if (input.configPath) {
    const absolute = resolveInProjectRoot(input.configPath, root);
    if (existsSync(absolute)) relativeOrAbsolutePath = absolute;
  } else {
    for (const candidate of CANDIDATE_FILENAMES) {
      const candidatePath = path.join(root, candidate);
      if (existsSync(candidatePath)) {
        relativeOrAbsolutePath = candidatePath;
        break;
      }
    }
  }

  if (!relativeOrAbsolutePath) {
    return {
      configPath: null,
      found: false,
      settings: {},
      warnings: [
        "No playwright.config.* found at the project root — flakiness-relevant settings (retries, trace, screenshot, fullyParallel, forbidOnly) could not be checked.",
      ],
      note: NOTE,
    };
  }

  const relativeConfigPath = path.relative(root, relativeOrAbsolutePath);
  const content = readFileSync(relativeOrAbsolutePath, "utf-8");

  const settings = {
    retries: extractSetting(content, "retries"),
    workers: extractSetting(content, "workers"),
    fullyParallel: extractSetting(content, "fullyParallel"),
    forbidOnly: extractSetting(content, "forbidOnly"),
    trace: extractSetting(content, "trace"),
    screenshot: extractSetting(content, "screenshot"),
    video: extractSetting(content, "video"),
  };

  const warnings: string[] = [];

  if (!settings.retries) {
    warnings.push("No `retries` setting found — flaky tests won't get an automatic retry in CI. Consider `retries: process.env.CI ? 2 : 0`.");
  }
  if (!settings.trace || /['"]off['"]/.test(settings.trace)) {
    warnings.push("`trace` is missing or 'off' — failures will be hard to diagnose without a trace. Consider `trace: 'on-first-retry'` or `'retain-on-failure'`.");
  }
  if (!settings.screenshot || /['"]off['"]/.test(settings.screenshot)) {
    warnings.push("`screenshot` is missing or 'off' — consider `screenshot: 'only-on-failure'` so get_failure_details has something to show.");
  }
  if (!settings.forbidOnly) {
    warnings.push("No `forbidOnly` setting found — a stray `test.only(...)` could silently skip the rest of the suite in CI. Consider `forbidOnly: !!process.env.CI`.");
  }
  if (!settings.fullyParallel) {
    warnings.push(
      "No `fullyParallel` setting found. Running fully parallel speeds up the suite, but only enable it once tests are verified isolated (see RESEARCH_CONTEXT.md best-practice scheme, category C)."
    );
  }

  return { configPath: relativeConfigPath, found: true, settings, warnings, note: NOTE };
}
