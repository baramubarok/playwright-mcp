import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { canonicalProjectRoot, resolveProjectPath } from "../lib/pathSecurity.js";
import { McpToolError } from "../lib/toolErrors.js";
import {
  ASSET_HELPER_SOURCE,
  ASSETS_README,
  envTemplate,
  GITIGNORE_TEMPLATE,
  packageJsonTemplate,
  PLAYWRIGHT_CONFIG_TEMPLATE,
  SELECTORS_HELPER_SOURCE,
  TEST_CASE_EXAMPLE_CSV,
  TEST_CASE_EXAMPLE_FEATURE,
  TEST_CASE_README,
  TSCONFIG_TEMPLATE,
  type QaProjectTemplateOptions,
} from "../templates/qaProject.js";
import { DIAGNOSTICS_FIXTURE_SOURCE } from "./scaffoldTestDomain.js";

const PROJECT_NAME_RULE = "must be lowercase letters, numbers, '-' or '_' (npm package name), at most 64 characters";
const ID_SELECTOR_RULE = "must be lowercase letters, numbers or '-' and start with a letter (used as the data-{ID_SELECTOR} attribute)";

export const initQaProjectInputShape = {
  projectRoot: z
    .string()
    .min(1)
    .describe("Absolute path of the new (or existing) QA automation repository. The folder is created when it does not exist."),
  projectName: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, PROJECT_NAME_RULE)
    .optional()
    .describe("npm package name. Defaults to the folder name."),
  baseUrl: z.string().optional().describe("Target website URL written to BASE_URL, e.g. \"https://staging.example.com\"."),
  apiUrl: z.string().optional().describe("Backend API URL written to API_URL."),
  idSelector: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/, ID_SELECTOR_RULE)
    .max(32)
    .optional()
    .describe("Custom selector attribute suffix written to ID_SELECTOR, e.g. \"cy\" for data-cy. Optional."),
  overwrite: z
    .boolean()
    .optional()
    .describe("Overwrite existing generated files. The .env file is never overwritten. Default: false."),
};

export const initQaProjectSchema = z.object(initQaProjectInputShape);
export type InitQaProjectInput = z.infer<typeof initQaProjectSchema>;

export interface InitQaProjectOutput {
  projectRoot: string;
  createdFiles: string[];
  skippedFiles: string[];
  envFile: string;
  env: { baseUrl: string; apiUrl: string; idSelector: string };
  /** Required .env keys that still have no value; fill them before running tests. */
  envTodo: string[];
  nextSteps: string[];
}

/** Only plain http(s) URLs without whitespace, quotes or comment characters can be written into .env safely. */
function normalizeUrl(value: string | undefined, field: string): string {
  if (value === undefined || value.trim() === "") return "";
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new McpToolError("INVALID_INPUT", `${field} must be a valid http(s) URL.`);
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || /[\s"'#`$\\]/.test(trimmed) || parsed.username || parsed.password) {
    throw new McpToolError("INVALID_INPUT", `${field} must be a plain http(s) URL without credentials, spaces, quotes or '#'.`);
  }
  return trimmed;
}

function defaultProjectName(root: string): string {
  const slug = path
    .basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 64);
  return slug || "qa-automation";
}

export function initQaProject(input: InitQaProjectInput): InitQaProjectOutput {
  if (!path.isAbsolute(input.projectRoot)) {
    throw new McpToolError("INVALID_PATH", "projectRoot must be an absolute path.");
  }
  if (input.projectRoot.includes("\0")) {
    throw new McpToolError("INVALID_PATH", "Project root contains an invalid null byte.");
  }

  const baseUrl = normalizeUrl(input.baseUrl, "baseUrl");
  const apiUrl = normalizeUrl(input.apiUrl, "apiUrl");
  const idSelector = input.idSelector ?? "";

  if (!existsSync(input.projectRoot)) mkdirSync(input.projectRoot, { recursive: true });
  const root = canonicalProjectRoot(input.projectRoot);

  const options: QaProjectTemplateOptions = {
    projectName: input.projectName ?? defaultProjectName(root),
    baseUrl,
    apiUrl,
    idSelector,
  };

  // `neverOverwrite` protects files that hold user-entered values (credentials in .env).
  const files: Array<{ relPath: string; content: string; neverOverwrite?: boolean }> = [
    { relPath: "package.json", content: packageJsonTemplate(options) },
    { relPath: "tsconfig.json", content: TSCONFIG_TEMPLATE },
    { relPath: "playwright.config.ts", content: PLAYWRIGHT_CONFIG_TEMPLATE },
    { relPath: ".env.example", content: envTemplate(options, "example") },
    { relPath: ".env", content: envTemplate(options, "local"), neverOverwrite: true },
    { relPath: ".gitignore", content: GITIGNORE_TEMPLATE },
    { relPath: "docs/test-case/README.md", content: TEST_CASE_README },
    { relPath: "docs/test-case/example.feature", content: TEST_CASE_EXAMPLE_FEATURE },
    { relPath: "docs/test-case/example.csv", content: TEST_CASE_EXAMPLE_CSV },
    { relPath: "assets/README.md", content: ASSETS_README },
    { relPath: "tests/e2e/support/diagnostics.fixture.ts", content: DIAGNOSTICS_FIXTURE_SOURCE },
    { relPath: "tests/e2e/support/assets.ts", content: ASSET_HELPER_SOURCE },
    { relPath: "tests/e2e/support/selectors.ts", content: SELECTORS_HELPER_SOURCE },
  ];

  // Preflight every destination (traversal and symlink checks) before writing anything.
  const targets = files.map((file) => ({ ...file, absPath: resolveProjectPath(file.relPath, root, { forWrite: true }) }));

  const createdFiles: string[] = [];
  const skippedFiles: string[] = [];
  for (const target of targets) {
    const overwrite = Boolean(input.overwrite) && !target.neverOverwrite;
    if (existsSync(target.absPath) && !overwrite) {
      skippedFiles.push(target.relPath);
      continue;
    }
    mkdirSync(path.dirname(target.absPath), { recursive: true });
    writeFileSync(target.absPath, target.content.trim() + "\n", {
      encoding: "utf-8",
      flag: overwrite ? "w" : "wx",
      // .env may receive credentials, so keep it owner-readable only.
      ...(target.neverOverwrite ? { mode: 0o600 } : {}),
    });
    createdFiles.push(target.relPath);
  }

  const envTodo: string[] = [];
  if (!baseUrl) envTodo.push("BASE_URL");
  if (!apiUrl) envTodo.push("API_URL");

  const nextSteps = [
    `Open ${root} as the workspace (or call set_project_root) so the other tools use this repo.`,
    ...(envTodo.length > 0 ? [`Fill ${envTodo.join(" and ")} in .env (also set TEST_USER/TEST_PASSWORD when the app needs login).`] : []),
    "Run 'npm install' and 'npx playwright install chromium' in the project.",
    "Put QA test case files (.feature or .csv) in docs/test-case/ and files used for uploads in assets/.",
    "If the app needs login, run scaffold_auth_setup (global auth handler with storageState).",
    "Run check_test_prerequisites to verify the setup, then scaffold_test_domain for each feature.",
  ];

  return {
    projectRoot: root,
    createdFiles,
    skippedFiles,
    envFile: ".env",
    env: { baseUrl, apiUrl, idSelector },
    envTodo,
    nextSteps,
  };
}
