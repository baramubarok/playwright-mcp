import { createRequire } from "node:module";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveProjectPath, validatePathWithinRoot } from "./pathSecurity.js";

export type BrowserInstallStatus = "installed" | "outdated" | "missing" | "unknown";
export type PackageResolution = "project" | "workspace";

export interface PlaywrightPrerequisites {
  packageInstalled: boolean;
  packageName?: "@playwright/test" | "playwright";
  packageVersion?: string;
  packagePath?: string;
  /** "workspace" when the package is hoisted to a monorepo/workspace root above the project. */
  resolvedFrom?: PackageResolution;
  cliAvailable: boolean;
  cliPath?: string;
  configFound: boolean;
  configPath?: string;
  browsers: {
    status: BrowserInstallStatus;
    cachePath?: string;
    installedBrowsers: string[];
    /** Browser builds the installed Playwright version expects, e.g. "chromium-1234". */
    expectedBrowsers?: string[];
    /** Branded browser channels (chrome, msedge, …) referenced by the config; they need no cache. */
    configuredChannels: string[];
  };
  ready: boolean;
  status: "ready" | "setup_required";
}

export interface AllurePrerequisites {
  adapterInstalled: boolean;
  adapterVersion?: string;
  cliAvailable: boolean;
  cliPath?: string;
  configuredReporter: boolean;
  resultsAvailable: boolean;
  reportAvailable: boolean;
  status: "ready" | "not_configured" | "setup_required" | "results_missing";
}

export interface TestPrerequisites {
  projectRoot: string;
  workspaceRoot?: string;
  packageJsonFound: boolean;
  playwright: PlaywrightPrerequisites;
  allure: AllurePrerequisites;
  nextSteps: string[];
  warnings: string[];
}

interface PackageInfo {
  name: string;
  version?: string;
  packageRoot: string;
  entryPath: string;
  binPath?: string;
  resolvedFrom: PackageResolution;
}

const CONFIG_FILENAMES = [
  "playwright.config.ts",
  "playwright.config.js",
  "playwright.config.mjs",
  "playwright.config.cjs",
  "playwright.config.mts",
  "playwright.config.cts",
];

function readJsonFile(filePath: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function dependencyDeclared(packageJson: Record<string, unknown> | undefined, packageName: string): boolean {
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const dependencies = packageJson?.[field];
    if (dependencies && typeof dependencies === "object" && packageName in dependencies) return true;
  }
  return false;
}

function packageRootFromEntry(entryPath: string): string | undefined {
  let current = path.dirname(entryPath);
  while (true) {
    const packageJsonPath = path.join(current, "package.json");
    if (existsSync(packageJsonPath)) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * Find the nearest ancestor that declares a JavaScript workspace (npm/yarn `workspaces`,
 * pnpm-workspace.yaml or lerna.json). Dependencies of workspace packages are often hoisted there.
 */
export function findWorkspaceRoot(projectRoot: string): string | undefined {
  let current = path.dirname(projectRoot);
  while (true) {
    if (existsSync(path.join(current, "pnpm-workspace.yaml")) || existsSync(path.join(current, "lerna.json"))) return current;
    const packageJson = readJsonFile(path.join(current, "package.json"));
    if (packageJson && "workspaces" in packageJson) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function isWithin(candidate: string, root: string): boolean {
  try {
    validatePathWithinRoot(candidate, root, candidate, { expectedType: "directory" });
    return true;
  } catch {
    return false;
  }
}

function resolvePackage(root: string, packageName: string, workspaceRoot?: string): PackageInfo | undefined {
  try {
    const requireFromProject = createRequire(path.join(root, "package.json"));
    const entryPath = requireFromProject.resolve(packageName);
    const packageRoot = packageRootFromEntry(entryPath);
    if (!packageRoot) return undefined;
    let resolvedFrom: PackageResolution;
    if (isWithin(packageRoot, root)) resolvedFrom = "project";
    else if (workspaceRoot && isWithin(packageRoot, workspaceRoot)) resolvedFrom = "workspace";
    else return undefined; // A stray package from an unrelated parent directory is not this project's dependency.
    const packageJson = readJsonFile(path.join(packageRoot, "package.json"));
    const bin = packageJson?.bin;
    let binValue: string | undefined;
    if (typeof bin === "string") {
      binValue = bin;
    } else if (bin && typeof bin === "object") {
      const namedBin =
        (bin as Record<string, unknown>)[packageName] ??
        (bin as Record<string, unknown>)[(packageName.startsWith("allure") ? "allure" : "playwright")];
      if (typeof namedBin === "string") binValue = namedBin;
    }
    const binPath = binValue ? path.resolve(packageRoot, binValue) : undefined;
    return {
      name: packageName,
      version: typeof packageJson?.version === "string" ? packageJson.version : undefined,
      packageRoot,
      entryPath,
      binPath: binPath && existsSync(binPath) ? binPath : undefined,
      resolvedFrom,
    };
  } catch {
    return undefined;
  }
}

function findConfig(root: string): { path?: string; content?: string } {
  for (const filename of CONFIG_FILENAMES) {
    try {
      const configPath = resolveProjectPath(filename, root, { mustExist: true, expectedType: "file" });
      return { path: configPath, content: readFileSync(configPath, "utf8") };
    } catch {
      // Continue looking for the next supported config filename.
    }
  }
  return {};
}

function browserCacheCandidates(playwrightPackageRoot?: string): string[] {
  const configuredPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (configuredPath === "0") {
    return playwrightPackageRoot ? [path.join(playwrightPackageRoot, ".local-browsers")] : [];
  }
  if (configuredPath) return [path.resolve(configuredPath)];

  const home = os.homedir();
  if (process.platform === "darwin") return [path.join(home, "Library", "Caches", "ms-playwright")];
  if (process.platform === "win32") {
    return [path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "ms-playwright")];
  }
  return [path.join(process.env.XDG_CACHE_HOME ?? path.join(home, ".cache"), "ms-playwright")];
}

const BROWSER_DIRECTORY_RE = /^(chromium|chromium_headless_shell|firefox|webkit)-(\d+)$/;
const ENGINE_BROWSERS = new Set(["chromium", "chromium-headless-shell", "firefox", "webkit"]);

/** Browser builds required by the installed Playwright, read from playwright-core/browsers.json. */
function expectedBrowserBuilds(playwrightPackageRoot?: string): Map<string, Set<string>> | undefined {
  if (!playwrightPackageRoot) return undefined;
  try {
    const requireFromPlaywright = createRequire(path.join(playwrightPackageRoot, "package.json"));
    const browsersJsonPath = requireFromPlaywright.resolve("playwright-core/browsers.json");
    const descriptor = readJsonFile(browsersJsonPath) as
      | { browsers?: Array<{ name?: string; revision?: string; installByDefault?: boolean; revisionOverrides?: Record<string, string> }> }
      | undefined;
    const builds = new Map<string, Set<string>>();
    for (const browser of descriptor?.browsers ?? []) {
      if (!browser.name || !browser.revision || !ENGINE_BROWSERS.has(browser.name) || browser.installByDefault === false) continue;
      builds.set(browser.name.replace(/-/g, "_"), new Set([browser.revision, ...Object.values(browser.revisionOverrides ?? {})]));
    }
    return builds.size > 0 ? builds : undefined;
  } catch {
    return undefined;
  }
}

export function detectConfiguredChannels(configContent: string | undefined): string[] {
  if (!configContent) return [];
  const channels = new Set<string>();
  for (const match of configContent.matchAll(/\bchannel\s*:\s*['"`]([\w.-]+)['"`]/g)) channels.add(match[1]);
  return [...channels];
}

function detectBrowsers(playwrightPackageRoot: string | undefined, configuredChannels: string[]): PlaywrightPrerequisites["browsers"] {
  const expected = expectedBrowserBuilds(playwrightPackageRoot);
  const expectedBrowsers = expected
    ? [...expected].map(([name, revisions]) => `${name}-${[...revisions][0]}`)
    : undefined;
  for (const cachePath of browserCacheCandidates(playwrightPackageRoot)) {
    try {
      if (!existsSync(cachePath) || !statSync(cachePath).isDirectory()) continue;
      const installedBrowsers = readdirSync(cachePath).filter(
        (entry) => BROWSER_DIRECTORY_RE.test(entry) && existsSync(path.join(cachePath, entry, "INSTALLATION_COMPLETE")),
      );
      let status: BrowserInstallStatus = installedBrowsers.length > 0 ? "installed" : "missing";
      if (status === "installed" && expected) {
        const matchesExpected = installedBrowsers.some((entry) => {
          const [, name, revision] = entry.match(BROWSER_DIRECTORY_RE) ?? [];
          return expected.get(name)?.has(revision) ?? false;
        });
        if (!matchesExpected) status = "outdated";
      }
      return { status, cachePath, installedBrowsers, expectedBrowsers, configuredChannels };
    } catch {
      return { status: "unknown", cachePath, installedBrowsers: [], expectedBrowsers, configuredChannels };
    }
  }
  return { status: "missing", installedBrowsers: [], expectedBrowsers, configuredChannels };
}

function findPathCommand(command: string): string | undefined {
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const candidates = process.platform === "win32" ? [command, `${command}.exe`, `${command}.cmd`] : [command];
  for (const entry of pathEntries) {
    for (const candidate of candidates) {
      const commandPath = path.join(entry, candidate);
      try {
        if (existsSync(commandPath) && statSync(commandPath).isFile()) return commandPath;
      } catch {
        // Ignore inaccessible PATH entries.
      }
    }
  }
  return undefined;
}

export function checkTestPrerequisites(projectRoot: string): TestPrerequisites {
  const packageJsonPath = resolveProjectPath("package.json", projectRoot, { mustExist: false, expectedType: "file" });
  const packageJson = existsSync(packageJsonPath) ? readJsonFile(packageJsonPath) : undefined;
  const workspaceRoot = findWorkspaceRoot(projectRoot);
  const playwrightTest = resolvePackage(projectRoot, "@playwright/test", workspaceRoot);
  const playwright = resolvePackage(projectRoot, "playwright", workspaceRoot);
  const playwrightPackage = playwrightTest ?? playwright;
  const playwrightCliPath = playwright?.binPath ?? playwrightTest?.binPath;
  const config = findConfig(projectRoot);
  const configuredChannels = detectConfiguredChannels(config.content);
  const browsers = detectBrowsers(playwright?.packageRoot ?? playwrightTest?.packageRoot, configuredChannels);
  // Branded channels (chrome/msedge) use the system browser, so a missing Playwright cache is not fatal.
  const browsersUsable = browsers.status === "installed" || configuredChannels.length > 0;
  const playwrightReady = Boolean(playwrightPackage && playwrightCliPath && browsersUsable);

  const allureAdapter = resolvePackage(projectRoot, "allure-playwright", workspaceRoot);
  const allureCommandline = resolvePackage(projectRoot, "allure-commandline", workspaceRoot);
  const allure3 = resolvePackage(projectRoot, "allure", workspaceRoot);
  const allureCliPath = allureCommandline?.binPath ?? allure3?.binPath ?? findPathCommand("allure");
  const configuredReporter = Boolean(config.content && /allure-playwright/i.test(config.content));
  const resultsPath = resolveProjectPath("allure-results", projectRoot);
  const reportPath = resolveProjectPath("allure-report/index.html", projectRoot);
  const resultsAvailable = existsSync(resultsPath);
  const reportAvailable = existsSync(reportPath);

  let allureStatus: AllurePrerequisites["status"] = "not_configured";
  if (configuredReporter || allureAdapter || allureCommandline) {
    if (!allureAdapter || !allureCliPath) allureStatus = "setup_required";
    else if (!configuredReporter) allureStatus = "setup_required";
    else if (!resultsAvailable) allureStatus = "results_missing";
    else allureStatus = "ready";
  }

  const nextSteps: string[] = [];
  const warnings: string[] = [];
  if (!playwrightPackage) nextSteps.push("Install Playwright in the target project: npm install -D @playwright/test");
  if (playwrightPackage && !playwrightCliPath) nextSteps.push("Repair the local Playwright installation so its CLI is available.");
  if (playwrightPackage && !browsersUsable && browsers.status === "missing") {
    nextSteps.push("Install Playwright browsers manually: npx playwright install");
  }
  if (playwrightPackage && !browsersUsable && browsers.status === "outdated") {
    nextSteps.push(
      `Installed browsers do not match Playwright ${playwrightPackage.version ?? ""}`.trimEnd() +
        `; update them manually: npx playwright install (expected ${browsers.expectedBrowsers?.join(", ") ?? "current builds"}).`,
    );
  }
  if (configuredChannels.length > 0 && browsers.status !== "installed") {
    warnings.push(`The config uses branded browser channel(s) ${configuredChannels.join(", ")}; they must be installed on this machine.`);
  }
  if (playwrightPackage?.resolvedFrom === "workspace") {
    warnings.push(`Playwright is resolved from the workspace root ${workspaceRoot}, not from the project itself.`);
  }
  if (!config.path) warnings.push("No playwright.config.* was found. Create one if the project needs custom test configuration.");
  if (allureStatus === "setup_required") {
    if (!allureAdapter) nextSteps.push("Install the optional Allure adapter: npm install -D allure-playwright");
    if (!allureCliPath) nextSteps.push("Install the optional Allure CLI: npm install -D allure-commandline");
  }
  if (allureStatus === "results_missing" && configuredReporter) {
    warnings.push("Allure is configured, but allure-results/ is not available yet. Run the Playwright suite before generating Allure.");
  }
  if (!configuredReporter && allureStatus === "not_configured") {
    warnings.push("Allure is optional and is not configured in this project.");
  }

  return {
    projectRoot,
    ...(workspaceRoot ? { workspaceRoot } : {}),
    packageJsonFound: existsSync(packageJsonPath),
    playwright: {
      packageInstalled: Boolean(playwrightPackage),
      packageName: playwrightPackage?.name as PlaywrightPrerequisites["packageName"],
      packageVersion: playwrightPackage?.version,
      packagePath: playwrightPackage?.packageRoot,
      resolvedFrom: playwrightPackage?.resolvedFrom,
      cliAvailable: Boolean(playwrightCliPath),
      cliPath: playwrightCliPath,
      configFound: Boolean(config.path),
      configPath: config.path,
      browsers,
      ready: playwrightReady,
      status: playwrightReady ? "ready" : "setup_required",
    },
    allure: {
      adapterInstalled: Boolean(allureAdapter),
      adapterVersion: allureAdapter?.version,
      cliAvailable: Boolean(allureCliPath),
      cliPath: allureCliPath,
      configuredReporter,
      resultsAvailable,
      reportAvailable,
      status: allureStatus,
    },
    nextSteps,
    warnings: dependencyDeclared(packageJson, "@playwright/test") || dependencyDeclared(packageJson, "playwright")
      ? warnings
      : ["Playwright is not declared in the target package.json.", ...warnings],
  };
}
