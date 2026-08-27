import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createPatch } from "diff";
import { z } from "zod";
import { resolveInProjectRoot } from "../lib/config.js";
import { checkSyntax } from "../lib/checkSyntax.js";
import { scoreContent } from "../lib/scoreContent.js";

export const writeTestFileInputShape = {
  specPath: z.string().describe("Path to write the spec file to, relative to PROJECT_ROOT, e.g. \"e2e/payment.spec.ts\"."),
  content: z.string().describe("Full file content to write."),
  overwrite: z
    .boolean()
    .optional()
    .describe("Must be true to replace an existing file. Defaults to false so existing tests are never silently clobbered."),
};

export const writeTestFileSchema = z.object(writeTestFileInputShape);
export type WriteTestFileInput = z.infer<typeof writeTestFileSchema>;

export interface WriteTestFileOutput {
  path: string;
  sizeBytes: number;
  created: boolean;
  written: boolean;
  syntaxErrors?: string[];
  locatorQuality?: ReturnType<typeof scoreContent>["locatorQuality"];
  assertionDensity?: ReturnType<typeof scoreContent>["assertionDensity"];
  antiPatterns?: ReturnType<typeof scoreContent>["antiPatterns"];
  qualityWarnings?: string[];
  diff?: string;
}

const SPEC_NAME_RE = /\.(spec|test)\.[cm]?[jt]sx?$/i;

export function writeTestFile(input: WriteTestFileInput): WriteTestFileOutput {
  const absolutePath = resolveInProjectRoot(input.specPath);
  const existed = existsSync(absolutePath);

  if (existed && !statSync(absolutePath).isFile()) {
    throw new Error(`Path exists and is not a file: ${input.specPath}`);
  }
  if (existed && !input.overwrite) {
    const currentSize = statSync(absolutePath).size;
    throw new Error(
      `File already exists at "${input.specPath}" (${currentSize} bytes). ` +
        `Use read_file to inspect it first, then pass overwrite:true to replace it.`
    );
  }

  const syntaxErrors = checkSyntax(input.content, input.specPath);
  if (syntaxErrors.length > 0) {
    return {
      path: input.specPath,
      sizeBytes: 0,
      created: !existed,
      written: false,
      syntaxErrors,
    };
  }

  const previousContent = existed ? readFileSync(absolutePath, "utf-8") : undefined;

  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, input.content, "utf-8");

  const { locatorQuality, assertionDensity, antiPatterns, warnings } = scoreContent(input.content);
  if (!SPEC_NAME_RE.test(input.specPath)) {
    warnings.push(
      `Filename "${input.specPath}" doesn't match the common Playwright spec pattern (*.spec.ts / *.test.ts) — verify it matches this project's testMatch config.`
    );
  }

  const diff =
    previousContent !== undefined && previousContent !== input.content
      ? createPatch(input.specPath, previousContent, input.content, "before", "after")
      : undefined;

  return {
    path: input.specPath,
    sizeBytes: Buffer.byteLength(input.content, "utf-8"),
    created: !existed,
    written: true,
    locatorQuality,
    assertionDensity,
    antiPatterns,
    qualityWarnings: warnings,
    diff,
  };
}
