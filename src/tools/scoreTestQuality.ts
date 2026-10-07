import { statSync, existsSync } from "node:fs";
import { z } from "zod";
import { findProjectRoot, resolveInProjectRoot } from "../lib/config.js";
import { scoreSpecAndRelatedPOMFiles, type ComprehensiveQualityScore } from "../lib/scoreContent.js";
import { generateQualityHtmlReport } from "../lib/htmlQualityReport.js";

export const scoreTestQualityInputShape = {
  specPath: z.string().describe("Path to the spec file or page object to score, relative to project root or absolute."),
  projectRoot: z
    .string()
    .optional()
    .describe("Optional path to the project root. If omitted, auto-detected by searching for playwright.config.*."),
  generateHtmlReport: z
    .boolean()
    .optional()
    .describe("Set to true to generate the standalone visual quality report at test-results/quality-report.html."),
};

export const scoreTestQualitySchema = z.object(scoreTestQualityInputShape);
export type ScoreTestQualityInput = z.infer<typeof scoreTestQualitySchema>;

export interface ScoreTestQualityOutput extends ComprehensiveQualityScore {
  qualityReportHtmlPath?: string;
}

export function scoreTestQuality(input: ScoreTestQualityInput): ScoreTestQualityOutput {
  const root = findProjectRoot(undefined, input.projectRoot);
  const absolutePath = resolveInProjectRoot(input.specPath, root, { mustExist: true, expectedType: "file" });
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
    throw new Error(`Spec file not found: ${input.specPath}`);
  }
  const score = scoreSpecAndRelatedPOMFiles(absolutePath, root);
  let qualityReportHtmlPath: string | undefined;
  if (input.generateHtmlReport) {
    try {
      qualityReportHtmlPath = generateQualityHtmlReport({
        score,
        projectRoot: root,
        specPath: input.specPath,
        suiteStatus: "passed",
      });
    } catch {
      // Ignore report generation failure
    }
  }

  return {
    ...score,
    qualityReportHtmlPath,
  };
}

