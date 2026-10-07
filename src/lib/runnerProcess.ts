import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export const DEFAULT_RUNNER_TIMEOUT_MS = 120_000;
export const MIN_RUNNER_TIMEOUT_MS = 100;
export const MAX_RUNNER_TIMEOUT_MS = 900_000;
export const DEFAULT_OUTPUT_LIMIT_BYTES = 64 * 1024;

export interface RunnerProcessOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  outputLimitBytes?: number;
}

export interface RunnerProcessResult {
  timeoutMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  spawnError?: string;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
}

export function validateRunnerTimeout(timeoutMs: number | undefined): number {
  const value = timeoutMs ?? DEFAULT_RUNNER_TIMEOUT_MS;
  if (!Number.isInteger(value) || value < MIN_RUNNER_TIMEOUT_MS || value > MAX_RUNNER_TIMEOUT_MS) {
    throw new Error(
      `timeoutMs must be an integer between ${MIN_RUNNER_TIMEOUT_MS} and ${MAX_RUNNER_TIMEOUT_MS} milliseconds.`,
    );
  }
  return value;
}

function appendBounded(current: string, text: string, limit: number): { value: string; truncated: boolean } {
  const next = current + text;
  if (Buffer.byteLength(next, "utf8") <= limit) return { value: next, truncated: false };

  const marker = "[output truncated]\n";
  const markerBytes = Buffer.from(marker, "utf8");
  if (limit <= markerBytes.byteLength) {
    return { value: markerBytes.subarray(0, limit).toString("utf8"), truncated: true };
  }
  const available = limit - markerBytes.byteLength;
  let retained = available > 0 ? Buffer.from(next, "utf8").subarray(-available).toString("utf8") : "";
  while (Buffer.byteLength(retained, "utf8") > available) retained = retained.slice(1);
  return { value: `${marker}${retained}`, truncated: true };
}

/** Children that are still running, so the server can terminate them when it shuts down. */
const activeChildren = new Set<ChildProcess>();

export function activeRunnerCount(): number {
  return activeChildren.size;
}

/** Synchronously signal every active runner process group. Safe to call from an exit handler. */
export function terminateActiveRunners(signal: NodeJS.Signals = "SIGKILL"): void {
  for (const child of activeChildren) killProcessTree(child, signal);
}

function killProcessTree(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      // detached:true makes the child the process-group leader on POSIX.
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The process may have exited between close and cleanup. Fall back to the child handle.
    }
  }
  if (child.killed) return;
  try {
    child.kill(signal);
  } catch {
    // Cleanup is best-effort and must remain idempotent.
  }
}

/** Spawn a runner with bounded diagnostics and idempotent timeout/cancellation cleanup. */
export function runRunnerProcess(
  executable: string,
  args: string[],
  options: RunnerProcessOptions,
): Promise<RunnerProcessResult> {
  const timeoutMs = validateRunnerTimeout(options.timeoutMs);
  const outputLimitBytes = options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES;
  if (!Number.isInteger(outputLimitBytes) || outputLimitBytes < 1) {
    throw new Error("outputLimitBytes must be a positive integer.");
  }
  const startedAt = Date.now();

  return new Promise((resolve) => {
    let child: ChildProcess | undefined;
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let cancelled = false;
    let spawnError: string | undefined;
    let settled = false;
    let cleanupStarted = false;
    let stopRequested = false;
    let timeoutHandle: NodeJS.Timeout | undefined;
    let killHandle: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (cleanupStarted) return;
      cleanupStarted = true;
      if (child) activeChildren.delete(child);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      // A pending SIGKILL escalation is kept on purpose: it reaps descendants (browsers, workers)
      // that are still alive in the process group after the leader exited on SIGTERM.
      if (killHandle && !stopRequested) clearTimeout(killHandle);
      options.signal?.removeEventListener("abort", onAbort);
    };

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        timeoutMs,
        exitCode,
        signal,
        spawnError,
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
        timedOut,
        cancelled,
        durationMs: Date.now() - startedAt,
      });
    };

    const requestStop = (reason: "timeout" | "cancel"): void => {
      stopRequested = true;
      if (reason === "timeout") timedOut = true;
      else cancelled = true;
      if (cleanupStarted || !child) return;
      const target = child;
      killProcessTree(target);
      killHandle = setTimeout(() => {
        if (stopRequested) {
          try {
            killProcessTree(target, "SIGKILL");
          } catch {
            // The child can exit while the escalation timer is pending.
          }
        }
        killHandle = undefined;
      }, 500);
    };

    function onAbort(): void {
      requestStop("cancel");
    }

    try {
      child = spawn(executable, args, {
        cwd: options.cwd,
        env: options.env,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      spawnError = error instanceof Error ? error.message : String(error);
      finish(null, null);
      return;
    }

    const spawned = child;
    activeChildren.add(spawned);
    // StringDecoder keeps multi-byte UTF-8 sequences intact when they span chunk boundaries.
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    child.stdout?.on("data", (chunk: Buffer) => {
      const result = appendBounded(stdout, stdoutDecoder.write(chunk), outputLimitBytes);
      stdout = result.value;
      stdoutTruncated ||= result.truncated;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const result = appendBounded(stderr, stderrDecoder.write(chunk), outputLimitBytes);
      stderr = result.value;
      stderrTruncated ||= result.truncated;
    });
    child.on("error", (error) => {
      // After a successful spawn, "error" can also report a failed kill(); only a spawn failure is fatal.
      if (spawned.pid !== undefined) return;
      spawnError = error.message;
      finish(null, null);
    });
    child.once("close", (exitCode, signal) => finish(exitCode, signal));

    timeoutHandle = setTimeout(() => requestStop("timeout"), timeoutMs);
    if (options.signal) {
      if (options.signal.aborted) requestStop("cancel");
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
