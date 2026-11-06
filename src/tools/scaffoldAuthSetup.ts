import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { findProjectRoot } from "../lib/config.js";
import { resolveProjectPath } from "../lib/pathSecurity.js";
import {
  AUTH_CONFIG_SOURCE,
  AUTH_PROJECTS_BLOCK,
  AUTH_SETUP_API_SOURCE,
  AUTH_SETUP_UI_SOURCE,
  AUTH_STATE_RELATIVE_PATH,
  authApiSource,
  authPageSource,
  type AuthTemplateOptions,
} from "../templates/authSetup.js";
import { DEFAULT_PROJECTS_LINE } from "../templates/qaProject.js";

const URL_PATH_RULE = "must start with '/' and contain only letters, numbers, '/', '-', '_' or '.'";
const urlPathSchema = z
  .string()
  .max(200)
  .regex(/^\/[A-Za-z0-9/_.-]*$/, URL_PATH_RULE)
  .refine((value) => !value.split("/").includes(".."), "must not contain '..' segments");

const PLAYWRIGHT_CONFIG_FILES = ["playwright.config.ts", "playwright.config.js", "playwright.config.mjs", "playwright.config.cjs", "playwright.config.mts", "playwright.config.cts"];

export const scaffoldAuthSetupInputShape = {
  mode: z
    .enum(["ui", "api"])
    .optional()
    .describe("'ui' (default) logs in through the login form; 'api' logs in with the backend API (cookies). Both save the session to .auth/user.json."),
  loginPath: urlPathSchema.optional().describe("Login page path for mode 'ui'. Default: /login."),
  apiLoginPath: urlPathSchema.optional().describe("Login endpoint path (relative to API_URL) for mode 'api'. Default: /api/v1/auth/login."),
  projectRoot: z.string().optional().describe("Optional path to the target project root. Auto-detected if omitted."),
  overwrite: z.boolean().optional().describe("Overwrite existing auth files. Default: false."),
};

export const scaffoldAuthSetupSchema = z.object(scaffoldAuthSetupInputShape);
export type ScaffoldAuthSetupInput = z.infer<typeof scaffoldAuthSetupSchema>;

export type AuthConfigStatus = "patched" | "already_configured" | "manual_required" | "not_found";

export interface ScaffoldAuthSetupOutput {
  mode: "ui" | "api";
  createdFiles: string[];
  skippedFiles: string[];
  /** Where the logged-in session is stored (git-ignored). */
  authStateFile: string;
  configStatus: AuthConfigStatus;
  /** Present when playwright.config could not be patched automatically; paste it into the config. */
  configSnippet?: string;
  gitignoreUpdated: boolean;
  nextSteps: string[];
}

function findConfigFile(root: string): string | undefined {
  return PLAYWRIGHT_CONFIG_FILES.find((name) => existsSync(path.join(root, name)));
}

export function scaffoldAuthSetup(input: ScaffoldAuthSetupInput): ScaffoldAuthSetupOutput {
  const root = findProjectRoot(undefined, input.projectRoot);
  const mode = input.mode ?? "ui";
  const options: AuthTemplateOptions = {
    loginPath: input.loginPath ?? "/login",
    apiLoginPath: input.apiLoginPath ?? "/api/v1/auth/login",
  };

  const files: Array<{ relPath: string; content: string }> = [
    { relPath: "tests/e2e/auth/auth.config.ts", content: AUTH_CONFIG_SOURCE },
    ...(mode === "ui"
      ? [
          { relPath: "tests/e2e/auth/auth.page.ts", content: authPageSource(options) },
          { relPath: "tests/e2e/auth/auth.setup.ts", content: AUTH_SETUP_UI_SOURCE },
        ]
      : [
          { relPath: "tests/e2e/auth/auth.api.ts", content: authApiSource(options) },
          { relPath: "tests/e2e/auth/auth.setup.ts", content: AUTH_SETUP_API_SOURCE },
        ]),
  ];

  const configName = findConfigFile(root);
  const gitignorePath = ".gitignore";

  // Preflight every destination (traversal and symlink checks) before writing anything.
  const targets = files.map((file) => ({ ...file, absPath: resolveProjectPath(file.relPath, root, { forWrite: true }) }));
  const configAbsPath = configName ? resolveProjectPath(configName, root, { forWrite: true }) : undefined;
  const gitignoreAbsPath = resolveProjectPath(gitignorePath, root, { forWrite: true });

  const createdFiles: string[] = [];
  const skippedFiles: string[] = [];
  for (const target of targets) {
    if (existsSync(target.absPath) && !input.overwrite) {
      skippedFiles.push(target.relPath);
      continue;
    }
    mkdirSync(path.dirname(target.absPath), { recursive: true });
    writeFileSync(target.absPath, target.content.trim() + "\n", { encoding: "utf-8", flag: input.overwrite ? "w" : "wx" });
    createdFiles.push(target.relPath);
  }

  let configStatus: AuthConfigStatus = "not_found";
  let configSnippet: string | undefined;
  if (configAbsPath && configName) {
    const content = readFileSync(configAbsPath, "utf-8");
    if (/storageState/.test(content)) {
      configStatus = "already_configured";
    } else if (content.includes(DEFAULT_PROJECTS_LINE)) {
      writeFileSync(configAbsPath, content.replace(DEFAULT_PROJECTS_LINE, AUTH_PROJECTS_BLOCK), "utf-8");
      configStatus = "patched";
    } else {
      configStatus = "manual_required";
      configSnippet = AUTH_PROJECTS_BLOCK;
    }
  } else {
    configSnippet = AUTH_PROJECTS_BLOCK;
  }

  let gitignoreUpdated = false;
  const ignoreEntry = AUTH_STATE_RELATIVE_PATH.split("/")[0] + "/";
  const currentIgnore = existsSync(gitignoreAbsPath) ? readFileSync(gitignoreAbsPath, "utf-8") : "";
  if (!currentIgnore.split(/\r?\n/).some((line) => line.trim() === ignoreEntry || line.trim() === ignoreEntry.slice(0, -1))) {
    const separator = currentIgnore.length > 0 && !currentIgnore.endsWith("\n") ? "\n" : "";
    writeFileSync(gitignoreAbsPath, currentIgnore + separator + ignoreEntry + "\n", "utf-8");
    gitignoreUpdated = true;
  }

  const nextSteps = [
    "Set TEST_USER and TEST_PASSWORD in .env (never commit them).",
    mode === "ui"
      ? `Make auth.page.ts match the real login form (use inspect_page on ${options.loginPath}); keep the assertion in expectLoggedIn() specific.`
      : `Align the endpoint (${options.apiLoginPath}) and payload fields in auth.api.ts with the real login API; set API_URL in .env.`,
    ...(configStatus === "manual_required" || configStatus === "not_found"
      ? ["Add the 'setup' project with storageState and dependencies from configSnippet to playwright.config.*."]
      : []),
    `Run the setup once (npx playwright test --project=setup); the session is saved to ${AUTH_STATE_RELATIVE_PATH} and reused by all tests.`,
    "Login/logout specs must start logged out: test.use({ storageState: { cookies: [], origins: [] } }).",
  ];

  return {
    mode,
    createdFiles,
    skippedFiles,
    authStateFile: AUTH_STATE_RELATIVE_PATH,
    configStatus,
    ...(configSnippet ? { configSnippet } : {}),
    gitignoreUpdated,
    nextSteps,
  };
}
