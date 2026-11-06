import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { findProjectRoot, resolveInProjectRoot } from "../lib/config.js";
import { analyzePlaywrightConfig, type ReporterAnalysis, type SettingDetail } from "../lib/configAnalysis.js";

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
  /** "ast": static TypeScript analysis; "text_scan": regex fallback when the config object is not statically reachable. */
  analysis: "ast" | "text_scan" | "none";
  /** Source text of each setting (kept for backward compatibility). */
  settings: {
    retries?: string;
    workers?: string;
    fullyParallel?: string;
    forbidOnly?: string;
    trace?: string;
    screenshot?: string;
    video?: string;
    reporter?: string;
  };
  settingDetails?: Record<string, SettingDetail>;
  reporters?: ReporterAnalysis;
  warnings: string[];
  limitations?: string[];
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
  "Static analysis of the config source (it is never executed). Values computed at runtime are reported with kind " +
  "'expression' and are not evaluated; settings provided through spreads, imports or helper functions may be missed.";

function extractSetting(content: string, key: string): string | undefined {
  const re = new RegExp(`\\b${key}\\s*:\\s*([^,\\n}]+)`);
  const match = content.match(re);
  return match ? match[1].trim() : undefined;
}

export function checkPlaywrightConfig(input: CheckPlaywrightConfigInput): CheckPlaywrightConfigOutput {
  let relativeOrAbsolutePath: string | null = null;
  let root: string;

  try {
    root = findProjectRoot(undefined, input.projectRoot);
  } catch {
    return {
      configPath: null,
      found: false,
      analysis: "none",
      settings: {},
      warnings: [
        "Playwright configuration (playwright.config.*) could not be located. Provide 'projectRoot' or run 'set_project_root'.",
      ],
      note: NOTE,
    };
  }

  if (input.configPath) {
    const absolute = resolveInProjectRoot(input.configPath, root, { mustExist: true, expectedType: "file" });
    if (existsSync(absolute)) relativeOrAbsolutePath = absolute;
  } else {
    for (const candidate of CANDIDATE_FILENAMES) {
      try {
        const candidatePath = resolveInProjectRoot(candidate, root, { mustExist: true, expectedType: "file" });
        relativeOrAbsolutePath = candidatePath;
        break;
      } catch {
        // Ignore missing or unsafe candidate files during auto-discovery.
      }
    }
  }

  if (!relativeOrAbsolutePath) {
    return {
      configPath: null,
      found: false,
      analysis: "none",
      settings: {},
      warnings: [
        "No playwright.config.* found at the project root — flakiness-relevant settings (retries, trace, screenshot, fullyParallel, forbidOnly) could not be checked.",
      ],
      note: NOTE,
    };
  }

  const relativeConfigPath = path.relative(root, relativeOrAbsolutePath);
  const content = readFileSync(relativeOrAbsolutePath, "utf-8");

  const analysis = analyzePlaywrightConfig(content, relativeOrAbsolutePath);
  const textScan = !analysis.found;
  const keys = ["retries", "workers", "fullyParallel", "forbidOnly", "trace", "screenshot", "video", "reporter"] as const;
  const settings: CheckPlaywrightConfigOutput["settings"] = {};
  for (const key of keys) {
    settings[key] = textScan ? extractSetting(content, key) : analysis.settings[key]?.value;
  }
  const isMissing = (key: (typeof keys)[number]) => (textScan ? !settings[key] : analysis.settings[key]?.kind === "missing");
  const isLiteralOff = (key: (typeof keys)[number]) => {
    const value = settings[key];
    const literal = textScan || analysis.settings[key]?.kind === "literal";
    return literal && value !== undefined && /^['"`]off['"`]$/.test(value.trim());
  };

  const warnings: string[] = [];

  if (isMissing("retries")) {
    warnings.push("No `retries` setting found — flaky tests won't get an automatic retry in CI. Consider `retries: process.env.CI ? 2 : 0`.");
  }
  if (isMissing("trace") || isLiteralOff("trace")) {
    warnings.push("`trace` is missing or 'off' — failures will be hard to diagnose and run_playwright_test cannot read browser console/network diagnostics from a trace. Consider `trace: 'retain-on-failure'` or `'on-first-retry'`.");
  }
  if (isMissing("screenshot") || isLiteralOff("screenshot")) {
    warnings.push("`screenshot` is missing or 'off' — consider `screenshot: 'only-on-failure'` so get_failure_details has something to show.");
  }
  if (isMissing("video") || isLiteralOff("video")) {
    warnings.push("`video` is missing or 'off' — consider `video: 'retain-on-failure'` in `use: { ... }` so test failures capture video recordings for QA & developers.");
  }
  if (isMissing("forbidOnly")) {
    warnings.push("No `forbidOnly` setting found — a stray `test.only(...)` could silently skip the rest of the suite in CI. Consider `forbidOnly: !!process.env.CI`.");
  }
  if (isMissing("fullyParallel")) {
    warnings.push(
      "No `fullyParallel` setting found. Running fully parallel speeds up the suite, but only enable it once tests are verified isolated."
    );
  }
  if (!textScan && analysis.reporters.determinable && !analysis.reporters.html) {
    warnings.push(
      analysis.reporters.detected.length === 0
        ? "No `reporter` configured (Playwright defaults to 'list') — add ['html'] if you want generate_test_report reporter:'html' to find a native report."
        : `Configured reporter(s) ${analysis.reporters.detected.join(", ")} do not include 'html' — generate_test_report reporter:'html' will have nothing to locate.`,
    );
  }

  const limitations = textScan
    ? ["The exported config object could not be analyzed statically; settings were read with a heuristic text scan.", ...analysis.limitations.slice(1)]
    : analysis.limitations;

  return {
    configPath: relativeConfigPath,
    found: true,
    analysis: textScan ? "text_scan" : "ast",
    settings,
    ...(textScan ? {} : { settingDetails: analysis.settings, reporters: analysis.reporters }),
    warnings,
    ...(limitations.length > 0 ? { limitations } : {}),
    note: NOTE,
  };
}
