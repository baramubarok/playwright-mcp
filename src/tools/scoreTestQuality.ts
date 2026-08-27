import { statSync, existsSync } from "node:fs";
import { z } from "zod";
import { findProjectRoot, resolveInProjectRoot } from "../lib/config.js";
import { scoreSpecAndRelatedPOMFiles, type ComprehensiveQualityScore } from "../lib/scoreContent.js";

export const scoreTestQualityInputShape = {
  specPath: z.string().describe("Path to the spec file or page object to score, relative to project root or absolute."),
  projectRoot: z
    .string()
    .optional()
    .describe("Optional path to the project root. If omitted, auto-detected by searching for playwright.config.*."),
};

export const scoreTestQualitySchema = z.object(scoreTestQualityInputShape);
export type ScoreTestQualityInput = z.infer<typeof scoreTestQualitySchema>;

export type ScoreTestQualityOutput = ComprehensiveQualityScore;

export function scoreTestQuality(input: ScoreTestQualityInput): ScoreTestQualityOutput {
  const root = findProjectRoot(input.specPath, input.projectRoot);
  const absolutePath = resolveInProjectRoot(input.specPath, root);
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
    throw new Error(`Spec file not found: ${input.specPath}`);
  }
  return scoreSpecAndRelatedPOMFiles(absolutePath, root);
}

