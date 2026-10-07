import { z } from "zod";

export class IdentifierValidationError extends Error {
  readonly code = "INVALID_IDENTIFIER";

  constructor(field: string, value: string, reason: string) {
    super(`Invalid ${field}: ${reason}.`);
    this.name = "IdentifierValidationError";
  }
}

/** Keeps generated file names well below common 255-byte file-name limits. */
export const MAX_IDENTIFIER_LENGTH = 64;
const IDENTIFIER_RULE = `must start with a letter, contain only letters, numbers, '-' or '_', and be at most ${MAX_IDENTIFIER_LENGTH} characters`;

export const safeIdentifierSchema = z
  .string()
  .max(MAX_IDENTIFIER_LENGTH, IDENTIFIER_RULE)
  .regex(/^[A-Za-z][A-Za-z0-9_-]*$/, IDENTIFIER_RULE);

export function assertSafeIdentifier(value: string, field: string): string {
  if (!safeIdentifierSchema.safeParse(value).success) {
    throw new IdentifierValidationError(field, value, IDENTIFIER_RULE);
  }
  return value;
}

export function assertUniqueNormalizedIdentifiers(values: string[], field: string, normalize: (value: string) => string): void {
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalize(value);
    if (seen.has(normalized)) {
      throw new IdentifierValidationError(field, value, `duplicates another value after normalization ("${normalized}")`);
    }
    seen.add(normalized);
  }
}
