import { McpToolError } from "../toolErrors.js";

const PLACEHOLDER = /\{\{(TEST_USER|TEST_PASSWORD)\}\}/g;

/** Only plain http(s) origins are ever allowed. */
export function originOf(value: string, field: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new McpToolError("INVALID_INPUT", `${field} must be a valid http(s) URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new McpToolError("INVALID_INPUT", `${field} must use http or https.`);
  }
  if (parsed.username || parsed.password) throw new McpToolError("INVALID_INPUT", `${field} must not contain credentials.`);
  return parsed.origin;
}

export interface OriginPolicy {
  baseUrl: string;
  allowedOrigins: string[];
}

/**
 * Builds the set of origins the inspector may navigate to: BASE_URL, API_URL and explicit extras.
 * Requiring BASE_URL keeps the tool from being pointed at arbitrary hosts.
 */
export function buildOriginPolicy(baseUrl: string | undefined, apiUrl: string | undefined, extraOrigins: string[] = []): OriginPolicy {
  if (!baseUrl) {
    throw new McpToolError("INVALID_INPUT", "BASE_URL is not set in .env. inspect_page only visits the application under test; set BASE_URL first.");
  }
  const origins = new Set<string>([originOf(baseUrl, "BASE_URL")]);
  if (apiUrl) origins.add(originOf(apiUrl, "API_URL"));
  for (const extra of extraOrigins) origins.add(originOf(extra, "allowedOrigins entry"));
  return { baseUrl, allowedOrigins: [...origins] };
}

/** Resolves an absolute URL or a path relative to BASE_URL and verifies its origin is allowed. */
export function resolveInspectUrl(value: string, policy: OriginPolicy): string {
  if (value.includes("\0") || /[\r\n]/.test(value)) throw new McpToolError("INVALID_INPUT", "url contains invalid characters.");
  let resolved: URL;
  try {
    resolved = new URL(value, policy.baseUrl);
  } catch {
    throw new McpToolError("INVALID_INPUT", `url "${value}" is not valid.`);
  }
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
    throw new McpToolError("INVALID_INPUT", "url must use http or https.");
  }
  if (resolved.username || resolved.password) throw new McpToolError("INVALID_INPUT", "url must not contain credentials.");
  if (!policy.allowedOrigins.includes(resolved.origin)) {
    throw new McpToolError(
      "INVALID_INPUT",
      `Origin ${resolved.origin} is not allowed. inspect_page only visits ${policy.allowedOrigins.join(", ")} (BASE_URL/API_URL from .env); pass allowedOrigins to add another origin, e.g. a login provider.`,
    );
  }
  return resolved.toString();
}

/** True when the text uses a {{TEST_USER}} / {{TEST_PASSWORD}} placeholder. */
export function usesSecretPlaceholder(value: string): boolean {
  PLACEHOLDER.lastIndex = 0;
  return PLACEHOLDER.test(value);
}
