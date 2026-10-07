import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

export class PathSecurityError extends Error {
  readonly code = "INVALID_PATH";

  constructor(message: string) {
    super(message);
    this.name = "PathSecurityError";
  }
}

export interface ResolvePathOptions {
  mustExist?: boolean;
  expectedType?: "file" | "directory";
  forWrite?: boolean;
}

function hasPathBoundary(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertLexicalBoundary(candidate: string, root: string, inputPath: string): void {
  if (!hasPathBoundary(candidate, root)) {
    throw new PathSecurityError(`Path "${inputPath}" resolves outside the project root and is not allowed.`);
  }
}

function assertRealBoundary(candidate: string, root: string, inputPath: string): void {
  let realCandidate: string;
  try {
    realCandidate = realpathSync(candidate);
  } catch {
    throw new PathSecurityError(`Path "${inputPath}" could not be resolved safely.`);
  }

  if (!hasPathBoundary(realCandidate, root)) {
    throw new PathSecurityError(`Path "${inputPath}" resolves outside the project root and is not allowed.`);
  }
}

function assertExistingParentBoundary(candidate: string, root: string, inputPath: string): void {
  let current = candidate;
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      throw new PathSecurityError(`Path "${inputPath}" could not be resolved safely.`);
    }
    current = parent;
  }
  assertRealBoundary(current, root, inputPath);
}

export function canonicalProjectRoot(projectRoot: string): string {
  if (projectRoot.includes("\0")) {
    throw new PathSecurityError("Project root contains an invalid null byte.");
  }

  const resolved = path.resolve(projectRoot);
  if (!existsSync(resolved)) {
    throw new PathSecurityError("Project root directory does not exist.");
  }

  try {
    if (!statSync(resolved).isDirectory()) {
      throw new PathSecurityError("Project root must be a directory.");
    }
    return realpathSync(resolved);
  } catch (error) {
    if (error instanceof PathSecurityError) throw error;
    throw new PathSecurityError("Project root could not be resolved safely.");
  }
}

/**
 * Validates an already-resolved candidate against a canonical project root.
 * Existing path components are checked through realpath so symlink escapes are rejected.
 */
export function validatePathWithinRoot(
  candidatePath: string,
  projectRoot: string,
  inputPath = candidatePath,
  options: ResolvePathOptions = {},
): string {
  if (candidatePath.includes("\0")) {
    throw new PathSecurityError("Path contains an invalid null byte.");
  }

  const root = canonicalProjectRoot(projectRoot);
  const candidate = path.resolve(candidatePath);
  assertLexicalBoundary(candidate, root, inputPath);

  if (existsSync(candidate)) {
    if (options.forWrite && lstatSync(candidate).isSymbolicLink()) {
      throw new PathSecurityError(`Path "${inputPath}" is a symlink and cannot be used as a write destination.`);
    }
    assertRealBoundary(candidate, root, inputPath);
    if (options.expectedType === "file" && !statSync(candidate).isFile()) {
      throw new PathSecurityError(`Path "${inputPath}" is not a file.`);
    }
    if (options.expectedType === "directory" && !statSync(candidate).isDirectory()) {
      throw new PathSecurityError(`Path "${inputPath}" is not a directory.`);
    }
  } else {
    assertExistingParentBoundary(candidate, root, inputPath);
  }

  if (options.mustExist && !existsSync(candidate)) {
    throw new PathSecurityError(`Path "${inputPath}" does not exist.`);
  }

  return candidate;
}

/** Resolve a client path relative to the project root with lexical and symlink checks. */
export function resolveProjectPath(
  inputPath: string,
  projectRoot: string,
  options: ResolvePathOptions = {},
): string {
  if (inputPath.includes("\0")) {
    throw new PathSecurityError("Path contains an invalid null byte.");
  }

  const root = canonicalProjectRoot(projectRoot);
  const candidate = path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(root, inputPath);
  return validatePathWithinRoot(candidate, root, inputPath, options);
}
