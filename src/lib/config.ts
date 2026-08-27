import { realpathSync, existsSync } from "node:fs";
import path from "node:path";

let _projectRoot: string | null = null;

const PLAYWRIGHT_CONFIG_FILES = [
  "playwright.config.ts",
  "playwright.config.js",
  "playwright.config.mjs",
  "playwright.config.cjs",
  "playwright.config.mts",
  "playwright.config.cts",
];

function validateAndResolve(dir: string): string {
  const resolved = path.resolve(dir);
  if (!existsSync(resolved)) {
    throw new Error(`Directory does not exist: ${resolved}`);
  }
  return realpathSync(resolved);
}

// Eagerly resolve from env if available (backward-compatible).
if (process.env.PROJECT_ROOT) {
  try {
    _projectRoot = validateAndResolve(process.env.PROJECT_ROOT);
  } catch {
    _projectRoot = null;
  }
}

/**
 * Searches upward from a starting directory to find a folder containing a Playwright config
 * or a package.json.
 */
export function autoDetectProjectRoot(fromPath?: string): string | null {
  let currentDir = fromPath ? path.resolve(fromPath) : process.cwd();

  // If fromPath points to an existing path
  if (existsSync(currentDir)) {
    try {
      const real = realpathSync(currentDir);
      currentDir = real;
    } catch {
      // Ignore realpath error
    }
  }

  // If it's a file path, start from dirname
  if (!existsSync(currentDir) || path.extname(currentDir)) {
    currentDir = path.dirname(currentDir);
  }

  let dir = currentDir;
  let packageJsonFallback: string | null = null;

  while (true) {
    // Check for playwright.config.*
    for (const configFile of PLAYWRIGHT_CONFIG_FILES) {
      if (existsSync(path.join(dir, configFile))) {
        return dir;
      }
    }

    // Remember highest package.json as secondary candidate
    if (!packageJsonFallback && existsSync(path.join(dir, "package.json"))) {
      packageJsonFallback = dir;
    }

    const parentDir = path.dirname(dir);
    if (parentDir === dir) {
      // Reached filesystem root
      break;
    }
    dir = parentDir;
  }

  return packageJsonFallback;
}

/**
 * Resolves the project root with the following fallback priority:
 * 1. Explicit `explicitRoot` parameter passed in tool call
 * 2. Auto-discovery upwards from `startPath` (looking for playwright.config.*)
 * 3. Auto-discovery upwards from `process.cwd()`
 * 4. Stored in-memory root (set via setProjectRoot or PROJECT_ROOT env var)
 * 5. Throws a clear, actionable error if nothing is found
 */
export function findProjectRoot(startPath?: string, explicitRoot?: string): string {
  if (explicitRoot) {
    return validateAndResolve(explicitRoot);
  }

  if (startPath) {
    const detected = autoDetectProjectRoot(startPath);
    if (detected) return detected;
  }

  const detectedFromCwd = autoDetectProjectRoot(process.cwd());
  if (detectedFromCwd) return detectedFromCwd;

  if (_projectRoot && existsSync(_projectRoot)) {
    return _projectRoot;
  }

  throw new Error(
    "Playwright configuration (playwright.config.*) could not be automatically located. " +
      "Please provide 'projectRoot' in the tool parameters, or configure it with the 'set_project_root' tool " +
      "(e.g. by asking the user for their workspace root directory)."
  );
}

export function setProjectRoot(dir: string): string {
  _projectRoot = validateAndResolve(dir);
  return _projectRoot;
}

export function getProjectRoot(): string {
  return findProjectRoot();
}

export function isProjectRootSet(): boolean {
  return _projectRoot !== null;
}

/**
 * Resolves a client-supplied relative path against the detected/specified PROJECT_ROOT
 * and guards against path traversal (e.g. "../../etc/passwd") escaping the sandbox.
 */
export function resolveInProjectRoot(relativePath: string, explicitRoot?: string): string {
  const root = findProjectRoot(relativePath, explicitRoot);
  const resolved = path.isAbsolute(relativePath)
    ? path.resolve(relativePath)
    : path.resolve(root, relativePath);

  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    throw new Error(
      `Path "${relativePath}" resolves outside project root "${root}" and is not allowed.`
    );
  }
  return resolved;
}
