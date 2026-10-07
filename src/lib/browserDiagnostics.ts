import { readFileSync, statSync } from "node:fs";
import { readZipEntries } from "./zipArchive.js";
import { stripAnsi } from "./text.js";

/** Attachment written by the scaffolded diagnostics fixture (see scaffold_test_domain). */
export const DIAGNOSTICS_ATTACHMENT_NAME = "mcp-diagnostics";

export const DIAGNOSTIC_LIMITS = {
  consoleMessages: 10,
  pageErrors: 5,
  failedRequests: 10,
  steps: 5,
  textLength: 500,
  maxTraceArchiveBytes: 200 * 1024 * 1024,
  maxTraceEntryBytes: 32 * 1024 * 1024,
  maxAttachmentBytes: 1024 * 1024,
} as const;

export type DiagnosticsSource = "trace" | "fixture";

export interface ConsoleDiagnostic {
  type: "error" | "warning";
  text: string;
  location?: string;
}

export interface PageErrorDiagnostic {
  message: string;
  stack?: string;
}

export interface RequestDiagnostic {
  url: string;
  method?: string;
  status?: number;
  failure?: string;
  resourceType?: string;
}

export interface BrowserDiagnostics {
  sources: DiagnosticsSource[];
  consoleMessages: ConsoleDiagnostic[];
  pageErrors: PageErrorDiagnostic[];
  failedRequests: RequestDiagnostic[];
  /** Last test steps up to the first failing Playwright call, read from the trace. */
  steps: string[];
  omitted: { consoleMessages: number; pageErrors: number; failedRequests: number };
}

export interface DiagnosticsAttachment {
  name: string;
  path?: string;
  body?: string;
  contentType?: string;
}

function truncate(value: string, limit: number = DIAGNOSTIC_LIMITS.textLength): string {
  const clean = stripAnsi(value);
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
}

class DiagnosticsBuilder {
  private readonly seen = new Set<string>();
  readonly result: BrowserDiagnostics = {
    sources: [],
    consoleMessages: [],
    pageErrors: [],
    failedRequests: [],
    steps: [],
    omitted: { consoleMessages: 0, pageErrors: 0, failedRequests: 0 },
  };

  addSource(source: DiagnosticsSource): void {
    if (!this.result.sources.includes(source)) this.result.sources.push(source);
  }

  private push<K extends "consoleMessages" | "pageErrors" | "failedRequests">(
    key: K,
    value: BrowserDiagnostics[K][number],
    limit: number,
  ): void {
    const dedupeKey = `${key}:${JSON.stringify(value)}`;
    if (this.seen.has(dedupeKey)) return;
    this.seen.add(dedupeKey);
    const list = this.result[key] as Array<BrowserDiagnostics[K][number]>;
    if (list.length >= limit) {
      this.result.omitted[key]++;
      return;
    }
    list.push(value);
  }

  console(type: string | undefined, text: string | undefined, location?: string): void {
    if (!text || (type !== "error" && type !== "warning")) return;
    this.push("consoleMessages", { type, text: truncate(text), ...(location ? { location } : {}) }, DIAGNOSTIC_LIMITS.consoleMessages);
  }

  pageError(message: string | undefined, stack?: string): void {
    if (!message) return;
    const firstFrames = stack ? truncate(stack.split("\n").slice(0, 4).join("\n")) : undefined;
    this.push("pageErrors", { message: truncate(message), ...(firstFrames ? { stack: firstFrames } : {}) }, DIAGNOSTIC_LIMITS.pageErrors);
  }

  request(value: RequestDiagnostic): void {
    if (!value.url) return;
    this.push("failedRequests", { ...value, url: truncate(value.url, 300) }, DIAGNOSTIC_LIMITS.failedRequests);
  }
}

function parseJsonLines(content: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event: unknown = JSON.parse(line);
      if (event && typeof event === "object") events.push(event as Record<string, unknown>);
    } catch {
      // Ignore partially written lines; traces of interrupted tests can end mid-line.
    }
  }
  return events;
}

type TraceEvent = Record<string, any>;

function collectTraceBrowserEvents(events: TraceEvent[], builder: DiagnosticsBuilder): void {
  for (const event of events) {
    if (event.type === "console") {
      const location = event.location?.url ? `${event.location.url}:${event.location.lineNumber ?? 0}` : undefined;
      builder.console(event.messageType, event.text, location);
    } else if (event.type === "event" && event.method === "pageError") {
      const error = event.params?.error?.error ?? event.params?.error;
      builder.pageError(error?.message ?? error?.value, error?.stack);
    }
  }
}

function collectTraceNetworkEvents(events: TraceEvent[], builder: DiagnosticsBuilder): void {
  for (const event of events) {
    if (event.type !== "resource-snapshot") continue;
    const snapshot = event.snapshot ?? {};
    const status: number | undefined = snapshot.response?.status;
    const failure: string | undefined = snapshot.response?._failureText;
    if ((typeof status === "number" && status >= 400) || failure) {
      builder.request({
        url: snapshot.request?.url ?? "",
        method: snapshot.request?.method,
        ...(typeof status === "number" && status > 0 ? { status } : {}),
        ...(failure ? { failure } : {}),
        ...(snapshot._resourceType ? { resourceType: snapshot._resourceType } : {}),
      });
    }
  }
}

const STEP_METHODS = new Set(["pw:api", "expect", "test.step"]);
// Calls made by page.route() handlers run concurrently with the test and are not steps of the flow.
const ROUTE_HANDLER_TITLE = /^(?:Fulfill|Abort|Continue|Fallback|Fetch) request$/;
const INFRASTRUCTURE_METHODS = new Set(["hook", "fixture"]);

/** Reconstruct user-visible steps from the test-runner trace, ignoring hooks and fixtures. */
export function extractTraceSteps(events: TraceEvent[], limit: number = DIAGNOSTIC_LIMITS.steps): string[] {
  const byId = new Map<string, TraceEvent>();
  const failedIds = new Set<string>();
  const ordered: TraceEvent[] = [];
  for (const event of events) {
    if (event.type === "before" && typeof event.callId === "string") {
      byId.set(event.callId, event);
      ordered.push(event);
    } else if (event.type === "after" && event.error && typeof event.callId === "string") {
      failedIds.add(event.callId);
    }
  }
  const insideInfrastructure = (event: TraceEvent): boolean => {
    let current: TraceEvent | undefined = event;
    while (current) {
      if (INFRASTRUCTURE_METHODS.has(current.method)) return true;
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return false;
  };

  const steps = ordered.filter(
    (event) => STEP_METHODS.has(event.method) && !ROUTE_HANDLER_TITLE.test(String(event.title ?? "")) && !insideInfrastructure(event),
  );
  const firstFailedLeaf = steps.findIndex((event) => event.method !== "test.step" && failedIds.has(event.callId));
  const relevant = firstFailedLeaf >= 0 ? steps.slice(0, firstFailedLeaf + 1) : steps;
  return relevant
    .slice(-limit)
    .map((event) => `${failedIds.has(event.callId) ? "[FAILED] " : ""}${truncate(String(event.title ?? event.method), 200)}`);
}

/** Read console, page-error, network and step diagnostics from a Playwright trace.zip. */
export function readTraceDiagnostics(tracePath: string, builder = new DiagnosticsBuilder()): BrowserDiagnostics {
  const entries = readZipEntries(tracePath, {
    filter: (name) => !name.includes("/") && (name.endsWith(".trace") || name.endsWith(".network")),
    maxArchiveBytes: DIAGNOSTIC_LIMITS.maxTraceArchiveBytes,
    maxEntryBytes: DIAGNOSTIC_LIMITS.maxTraceEntryBytes,
  });
  let stepEvents: TraceEvent[] = [];
  for (const [name, data] of [...entries].sort(([left], [right]) => left.localeCompare(right))) {
    const events = parseJsonLines(data.toString("utf8"));
    if (name === "test.trace") stepEvents = events;
    else if (name.endsWith(".network")) collectTraceNetworkEvents(events, builder);
    else collectTraceBrowserEvents(events, builder);
  }
  builder.addSource("trace");
  if (stepEvents.length > 0) builder.result.steps = extractTraceSteps(stepEvents);
  return builder.result;
}

function readAttachmentText(attachment: DiagnosticsAttachment, canReadPath: (filePath: string) => boolean): string | undefined {
  if (attachment.body) {
    const text = Buffer.from(attachment.body, "base64").toString("utf8");
    return text.length <= DIAGNOSTIC_LIMITS.maxAttachmentBytes ? text : undefined;
  }
  if (attachment.path && canReadPath(attachment.path) && statSync(attachment.path).size <= DIAGNOSTIC_LIMITS.maxAttachmentBytes) {
    return readFileSync(attachment.path, "utf8");
  }
  return undefined;
}

function collectFixtureDiagnostics(text: string, builder: DiagnosticsBuilder): void {
  const parsed = JSON.parse(text) as {
    consoleMessages?: Array<{ type?: string; text?: string; location?: string }>;
    pageErrors?: Array<{ message?: string; stack?: string }>;
    failedRequests?: RequestDiagnostic[];
  };
  for (const message of parsed.consoleMessages ?? []) builder.console(message.type, message.text, message.location);
  for (const error of parsed.pageErrors ?? []) builder.pageError(error.message, error.stack);
  for (const request of parsed.failedRequests ?? []) {
    builder.request({
      url: String(request.url ?? ""),
      ...(request.method ? { method: String(request.method) } : {}),
      ...(typeof request.status === "number" ? { status: request.status } : {}),
      ...(request.failure ? { failure: String(request.failure) } : {}),
      ...(request.resourceType ? { resourceType: String(request.resourceType) } : {}),
    });
  }
  builder.addSource("fixture");
}

export interface CollectDiagnosticsOptions {
  /** Authorizes reading an attachment from disk. Paths come from report JSON and are untrusted. */
  canReadPath: (filePath: string) => boolean;
}

/**
 * Build bounded browser diagnostics for one failing attempt from real Playwright artifacts:
 * the scaffolded fixture attachment (page events recorded in the browser) and/or trace.zip.
 * Returns undefined when neither source is available.
 */
export function collectBrowserDiagnostics(
  attachments: DiagnosticsAttachment[],
  options: CollectDiagnosticsOptions,
): BrowserDiagnostics | undefined {
  const builder = new DiagnosticsBuilder();
  for (const attachment of attachments) {
    try {
      if (attachment.name === DIAGNOSTICS_ATTACHMENT_NAME) {
        const text = readAttachmentText(attachment, options.canReadPath);
        if (text) collectFixtureDiagnostics(text, builder);
      } else if (attachment.name === "trace" && attachment.path && options.canReadPath(attachment.path)) {
        readTraceDiagnostics(attachment.path, builder);
      }
    } catch {
      // Diagnostics are best-effort and must never fail the tool call.
    }
  }
  return builder.result.sources.length > 0 ? builder.result : undefined;
}
