import { existsSync } from "node:fs";
import { z } from "zod";
import { findProjectRoot } from "../lib/config.js";
import { ERROR_MARKER, INSPECT_CHILD_SCRIPT, RESULT_MARKER } from "../lib/inspect/childScript.js";
import { buildOriginPolicy, resolveInspectUrl, usesSecretPlaceholder } from "../lib/inspect/origins.js";
import { stableAttributes, summarizeElements, type InspectedElement, type RawElement } from "../lib/inspect/selectors.js";
import { resolveProjectPath } from "../lib/pathSecurity.js";
import { readQaEnv } from "../lib/qaEnv.js";
import { runRunnerProcess } from "../lib/runnerProcess.js";
import { McpToolError, type ToolErrorCode } from "../lib/toolErrors.js";

const AUTH_STATE_PATH = ".auth/user.json";
const DEFAULT_TIMEOUT_MS = 45_000;
const OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024;
const ARIA_MAX_CHARS = 4000;

const targetSchema = z.string().min(1).max(300).describe("Playwright selector, e.g. role=button[name=\"Login\"], [data-qa=\"submit\"] or text=Sign in.");
const valueSchema = z.string().max(200).describe("Text to enter. Use {{TEST_USER}} / {{TEST_PASSWORD}} to take credentials from .env; they are never returned.");

const stepSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("goto"), url: z.string().min(1).max(500).describe("URL or path (relative to BASE_URL) on an allowed origin.") }),
  z.object({ action: z.literal("click"), target: targetSchema }),
  z.object({ action: z.literal("check"), target: targetSchema }),
  z.object({ action: z.literal("waitFor"), target: targetSchema }),
  z.object({ action: z.literal("fill"), target: targetSchema, value: valueSchema }),
  z.object({ action: z.literal("select"), target: targetSchema, value: valueSchema }),
  z.object({ action: z.literal("press"), target: targetSchema, key: z.string().regex(/^[A-Za-z0-9+]{1,30}$/, "e.g. Enter or Control+A") }),
  z.object({ action: z.literal("snapshot"), label: z.string().max(60).optional().describe("Name of the state to capture, e.g. \"login error\".") }),
]);

export const inspectPageInputShape = {
  url: z
    .string()
    .max(500)
    .optional()
    .describe("Page to inspect: a path relative to BASE_URL (e.g. \"/login\") or a full URL on an allowed origin. Default: \"/\"."),
  steps: z
    .array(stepSchema)
    .max(20)
    .optional()
    .describe("Actions to reach other UI states (open a modal, fill a form, next wizard step). A state is captured at the start, after each 'snapshot' step, at the end, and where a step fails."),
  useAuth: z.boolean().optional().describe("Reuse the saved login session (.auth/user.json from scaffold_auth_setup) for pages behind login. Default: false."),
  maxElements: z.number().int().min(5).max(200).optional().describe("Maximum elements listed per state. Default: 60."),
  includeAriaSnapshot: z.boolean().optional().describe("Include a truncated ARIA snapshot per state (Playwright 1.49+). Default: true."),
  browser: z.enum(["chromium", "firefox", "webkit"]).optional().describe("Browser engine. Default: chromium."),
  allowedOrigins: z.array(z.string().max(300)).max(5).optional().describe("Extra origins navigation may reach (e.g. a login provider). BASE_URL and API_URL are always allowed."),
  timeoutMs: z.number().int().min(5_000).max(180_000).optional().describe(`Overall time limit. Default: ${DEFAULT_TIMEOUT_MS}.`),
  projectRoot: z.string().optional().describe("Optional path to the QA project root. Auto-detected if omitted."),
};

export const inspectPageSchema = z.object(inspectPageInputShape);
export type InspectPageInput = z.infer<typeof inspectPageSchema>;
type Step = z.infer<typeof stepSchema>;

export interface InspectedState {
  label: string;
  url: string;
  title: string;
  httpStatus?: number;
  /** Elements that could be identified, before the maxElements limit. */
  totalElements: number;
  truncated: boolean;
  elements: InspectedElement[];
  iframeCount?: number;
  ariaSnapshot?: string;
}

export interface InspectPageOutput {
  baseUrl: string;
  startUrl: string;
  authUsed: boolean;
  /** Attribute getByTestId() reads (from ID_SELECTOR in .env). */
  testIdAttribute: string;
  allowedOrigins: string[];
  states: InspectedState[];
  steps: Array<{ index: number; action: string; target?: string; ok: boolean; error?: string }>;
  blockedOrigins: string[];
  hints: string[];
  warnings: string[];
}

interface ChildState {
  label: string;
  url: string;
  title: string;
  httpStatus?: number;
  raw: RawElement[];
  found: number;
  iframeCount: number;
  ariaSnapshot?: string;
}

interface ChildResult {
  states: ChildState[];
  steps: InspectPageOutput["steps"];
  blockedOrigins: string[];
}

function extractMarked<T>(stdout: string, marker: string): T | undefined {
  const index = stdout.lastIndexOf(marker);
  if (index < 0) return undefined;
  const line = stdout.slice(index + marker.length).split(/\r?\n/, 1)[0];
  try {
    return JSON.parse(line) as T;
  } catch {
    return undefined;
  }
}

function usesSecrets(steps: Step[]): boolean {
  return steps.some((step) => (step.action === "fill" || step.action === "select") && usesSecretPlaceholder(step.value));
}

/** Replaces secret values anywhere in the result (e.g. an ARIA snapshot taken after typing a password). */
export function redactSecrets<T>(value: T, secrets: Record<string, string>): T {
  let json = JSON.stringify(value);
  for (const secret of Object.values(secrets)) {
    if (secret.length < 3) continue;
    json = json.split(JSON.stringify(secret).slice(1, -1)).join("{{redacted}}");
  }
  return JSON.parse(json) as T;
}

export async function inspectPage(input: InspectPageInput, options: { signal?: AbortSignal } = {}): Promise<InspectPageOutput> {
  const root = findProjectRoot(undefined, input.projectRoot);
  const env = readQaEnv(root);
  const policy = buildOriginPolicy(env.baseUrl, env.apiUrl, input.allowedOrigins);
  const startUrl = resolveInspectUrl(input.url ?? "/", policy);

  // goto steps are validated here so the browser never receives an origin that is not allowed.
  const steps = (input.steps ?? []).map((step): Step => (step.action === "goto" ? { ...step, url: resolveInspectUrl(step.url, policy) } : step));

  const secrets: Record<string, string> = {};
  if (usesSecrets(steps)) {
    for (const key of ["TEST_USER", "TEST_PASSWORD"]) {
      const value = env.values[key];
      if (value) secrets[key] = value;
    }
    const missing = ["TEST_USER", "TEST_PASSWORD"].filter((key) => !secrets[key] && steps.some((step) => (step.action === "fill" || step.action === "select") && step.value.includes(`{{${key}}}`)));
    if (missing.length > 0) throw new McpToolError("INVALID_INPUT", `${missing.join(" and ")} must be set in .env to use the {{${missing[0]}}} placeholder.`);
  }

  const warnings: string[] = [];
  let storageStatePath: string | undefined;
  if (input.useAuth) {
    const candidate = resolveProjectPath(AUTH_STATE_PATH, root);
    if (existsSync(candidate)) storageStatePath = candidate;
    else warnings.push(`useAuth was requested but ${AUTH_STATE_PATH} does not exist; inspecting without a login session. Run scaffold_auth_setup and the setup project first.`);
  }

  const maxElements = input.maxElements ?? 60;
  const childInput = {
    startUrl,
    steps,
    attributes: stableAttributes(env.idSelector),
    allowedOrigins: policy.allowedOrigins,
    storageStatePath,
    browser: input.browser ?? "chromium",
    maxRaw: Math.min(800, maxElements * 4),
    includeAria: input.includeAriaSnapshot ?? true,
    ariaMaxChars: ARIA_MAX_CHARS,
    navTimeoutMs: 20_000,
    stepTimeoutMs: 8_000,
  };

  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const run = await runRunnerProcess(process.execPath, ["-e", INSPECT_CHILD_SCRIPT], {
    cwd: root,
    env: { ...process.env, PW_MCP_INSPECT_INPUT: JSON.stringify(childInput), PW_MCP_INSPECT_SECRETS: JSON.stringify(secrets) },
    timeoutMs,
    signal: options.signal,
    outputLimitBytes: OUTPUT_LIMIT_BYTES,
  });

  if (run.cancelled) throw new McpToolError("INSPECT_FAILED", "inspect_page was cancelled.");
  if (run.timedOut) throw new McpToolError("INSPECT_TIMEOUT", `inspect_page timed out after ${Math.round(timeoutMs / 1000)}s. Reduce the steps or raise timeoutMs.`);
  if (run.spawnError) throw new McpToolError("INSPECT_FAILED", `Could not start Node: ${run.spawnError}`);

  const failure = extractMarked<{ code: string; message: string }>(run.stdout, ERROR_MARKER);
  if (failure) throw new McpToolError((failure.code as ToolErrorCode) ?? "INSPECT_FAILED", failure.message);
  const result = extractMarked<ChildResult>(run.stdout, RESULT_MARKER);
  if (!result) {
    const detail = run.stderr.trim().split(/\r?\n/).slice(-3).join(" ").slice(0, 400);
    throw new McpToolError("INSPECT_FAILED", `inspect_page produced no result (exit ${run.exitCode ?? "none"}${run.stdoutTruncated ? ", output truncated" : ""}). ${detail}`.trim());
  }

  const config = { idSelector: env.idSelector, testIdAttribute: env.testIdAttribute };
  const hints: string[] = [];
  const states = result.states.map((state): InspectedState => {
    const summary = summarizeElements(state.raw, config, maxElements);
    if (state.httpStatus !== undefined && state.httpStatus >= 400) warnings.push(`State "${state.label}" responded with HTTP ${state.httpStatus}.`);
    if (summary.truncated) hints.push(`State "${state.label}": ${summary.total} elements found, ${summary.elements.length} listed; raise maxElements or inspect after a step to narrow down.`);
    if (summary.ambiguousCount > 0) {
      hints.push(`State "${state.label}": ${summary.ambiguousCount} locator(s) match several elements (count > 1); scope them inside a container (dialog, form, list item) instead of using .nth()/.first().`);
    }
    if (summary.total === 0) hints.push(`State "${state.label}": no identifiable elements; the page may still be loading, require login (useAuth), or render inside an iframe.`);
    return {
      label: state.label,
      url: state.url,
      title: state.title,
      ...(state.httpStatus !== undefined ? { httpStatus: state.httpStatus } : {}),
      totalElements: summary.total,
      truncated: summary.truncated,
      elements: summary.elements,
      ...(state.iframeCount > 0 ? { iframeCount: state.iframeCount } : {}),
      ...(state.ariaSnapshot ? { ariaSnapshot: state.ariaSnapshot } : {}),
    };
  });

  const frames = Math.max(0, ...states.map((state) => state.iframeCount ?? 0));
  if (frames > 0) hints.push(`The page contains ${frames} iframe(s); elements inside iframes are not listed (use page.frameLocator(...) manually).`);
  const helpers = new Set(states.flatMap((state) => state.elements.flatMap((element) => element.locator.match(/^(byTestId|byQa|byEnvId)\(/)?.[1] ?? [])));
  if (helpers.size > 0) hints.push(`Import ${[...helpers].sort().join(", ")} from tests/e2e/support/selectors in the page object.`);
  for (const blocked of result.blockedOrigins) warnings.push(`Navigation to ${blocked} was blocked (origin not allowed).`);

  return redactSecrets(
    {
      baseUrl: policy.baseUrl,
      startUrl,
      authUsed: storageStatePath !== undefined,
      testIdAttribute: env.testIdAttribute,
      allowedOrigins: policy.allowedOrigins,
      states,
      steps: result.steps,
      blockedOrigins: result.blockedOrigins,
      hints,
      warnings,
    },
    secrets,
  );
}
