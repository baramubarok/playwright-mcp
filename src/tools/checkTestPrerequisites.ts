import { z } from "zod";
import { findProjectRoot } from "../lib/config.js";
import { checkTestPrerequisites, type TestPrerequisites } from "../lib/prerequisites.js";

export const checkTestPrerequisitesInputShape = {
  projectRoot: z.string().optional().describe("Optional path to the target project root. Auto-detected if omitted."),
};

export const checkTestPrerequisitesSchema = z.object(checkTestPrerequisitesInputShape);
export type CheckTestPrerequisitesInput = z.infer<typeof checkTestPrerequisitesSchema>;
export type CheckTestPrerequisitesOutput = TestPrerequisites;

export function checkTestPrerequisitesTool(input: CheckTestPrerequisitesInput): CheckTestPrerequisitesOutput {
  const root = findProjectRoot(undefined, input.projectRoot);
  return checkTestPrerequisites(root);
}
