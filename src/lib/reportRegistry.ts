import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** Number of runner report directories kept for follow-up get_failure_details calls. */
export const MAX_RETAINED_RUN_REPORTS = 20;

const registeredReports = new Set<string>();
// Insertion-ordered: the first entry is the oldest managed run directory.
const managedRunDirectories = new Map<string, string | undefined>();

export function registerReportPath(reportPath: string): void {
  if (existsSync(reportPath)) {
    registeredReports.add(realpathSync(reportPath));
  } else {
    registeredReports.add(path.resolve(reportPath));
  }
}

export function isRegisteredReportPath(reportPath: string): boolean {
  if (!existsSync(reportPath)) return false;
  try {
    return registeredReports.has(realpathSync(reportPath));
  } catch {
    return false;
  }
}

function removeRunDirectory(directory: string): void {
  const reportPath = managedRunDirectories.get(directory);
  managedRunDirectories.delete(directory);
  if (reportPath) registeredReports.delete(reportPath);
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {
    // Cleanup is best-effort; the OS temp directory is reclaimed eventually.
  }
}

/**
 * Create a temporary directory for one runner execution's JSON report. Older directories beyond
 * MAX_RETAINED_RUN_REPORTS are deleted, so a long-lived server does not leak temp files.
 */
export function createRunReportDirectory(): string {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "pw-mcp-report-")));
  managedRunDirectories.set(directory, undefined);
  while (managedRunDirectories.size > MAX_RETAINED_RUN_REPORTS) {
    const oldest = managedRunDirectories.keys().next().value as string;
    removeRunDirectory(oldest);
  }
  return directory;
}

/** Register the JSON report produced inside a managed run directory. */
export function registerRunReport(directory: string, reportPath: string): void {
  registerReportPath(reportPath);
  if (managedRunDirectories.has(directory) && existsSync(reportPath)) {
    managedRunDirectories.set(directory, realpathSync(reportPath));
  }
}

/** Release a run directory that produced no usable report. */
export function discardRunReportDirectory(directory: string): void {
  if (managedRunDirectories.has(directory)) removeRunDirectory(directory);
}

/** Remove every managed run directory. Synchronous so it can run from a process exit handler. */
export function cleanupRunReports(): void {
  for (const directory of [...managedRunDirectories.keys()]) removeRunDirectory(directory);
}

export function managedRunReportCount(): number {
  return managedRunDirectories.size;
}
