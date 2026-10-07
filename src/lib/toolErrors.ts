import { IdentifierValidationError } from "./safeIdentifier.js";
import { PathSecurityError } from "./pathSecurity.js";

export type ToolErrorCode =
  | "INVALID_PATH"
  | "INVALID_IDENTIFIER"
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "PROJECT_ROOT_NOT_FOUND"
  | "REPORT_ACCESS_DENIED"
  | "REPORT_NOT_FOUND"
  | "REPORT_TOO_LARGE"
  | "REPORT_MALFORMED"
  | "AMBIGUOUS_TEST"
  | "TEST_NOT_FOUND"
  | "TEST_NOT_FAILED"
  | "INTERNAL_ERROR";

export interface ToolErrorPayload {
  code: ToolErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

/** An error with a stable machine-readable code, surfaced to MCP clients as `{ code, message, details }`. */
export class McpToolError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "McpToolError";
  }
}

export function toToolErrorPayload(error: unknown): ToolErrorPayload {
  if (error instanceof McpToolError) {
    return { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) };
  }
  if (error instanceof PathSecurityError || error instanceof IdentifierValidationError) {
    return { code: error.code, message: error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/could not be automatically located/.test(message)) return { code: "PROJECT_ROOT_NOT_FOUND", message };
  if (/not found/i.test(message)) return { code: "NOT_FOUND", message };
  if (/must be an integer between|outputLimitBytes/.test(message)) return { code: "INVALID_INPUT", message };
  return { code: "INTERNAL_ERROR", message };
}
