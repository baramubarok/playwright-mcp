import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/** Keys every QA automation project must define in its `.env`. */
export const REQUIRED_ENV_KEYS = ["BASE_URL"] as const;
/** Keys the QA template defines; missing optional keys only produce a note. */
export const OPTIONAL_ENV_KEYS = ["API_URL", "ID_SELECTOR", "TEST_USER", "TEST_PASSWORD"] as const;

const MAX_ENV_FILE_BYTES = 64 * 1024;

export interface QaEnv {
  envFileFound: boolean;
  values: Record<string, string>;
  /** Required keys that are absent or empty. */
  missingRequired: string[];
  /** Optional template keys that are absent or empty. */
  missingOptional: string[];
  baseUrl?: string;
  apiUrl?: string;
  idSelector?: string;
  /** Attribute used by getByTestId, e.g. "data-qa". Falls back to "data-testid". */
  testIdAttribute: string;
}

/** Minimal dotenv-compatible parser: KEY=value, optional quotes, `#` comments. No expansion. */
export function parseEnv(source: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.lastIndexOf(quote) > 0) {
      value = value.slice(1, value.lastIndexOf(quote));
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    values[match[1]] = value;
  }
  return values;
}

/** Reads `<root>/.env` (never `.env.*`) without executing or expanding anything. */
export function readQaEnv(projectRoot: string): QaEnv {
  const envPath = path.join(projectRoot, ".env");
  let values: Record<string, string> = {};
  let envFileFound = false;
  if (existsSync(envPath) && statSync(envPath).isFile() && statSync(envPath).size <= MAX_ENV_FILE_BYTES) {
    envFileFound = true;
    values = parseEnv(readFileSync(envPath, "utf-8"));
  }

  const present = (key: string) => (values[key] ?? "").trim().length > 0;
  const idSelector = present("ID_SELECTOR") ? values.ID_SELECTOR.trim() : undefined;
  return {
    envFileFound,
    values,
    missingRequired: REQUIRED_ENV_KEYS.filter((key) => !present(key)),
    missingOptional: OPTIONAL_ENV_KEYS.filter((key) => !present(key)),
    baseUrl: present("BASE_URL") ? values.BASE_URL.trim() : undefined,
    apiUrl: present("API_URL") ? values.API_URL.trim() : undefined,
    idSelector,
    testIdAttribute: idSelector ? `data-${idSelector}` : "data-testid",
  };
}
