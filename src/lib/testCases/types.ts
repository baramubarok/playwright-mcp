export interface TestCase {
  /** From an ID tag/column (TC-001); generated from the file name and position when absent. */
  id: string;
  title: string;
  feature?: string;
  /** smoke, regression, P1, ... when stated in a tag or the Priority column. */
  priority?: string;
  tags: string[];
  /** Given steps and Background (Gherkin) or the Preconditions column. */
  preconditions: string[];
  /** The actions: When steps (Gherkin) or the Steps column. */
  steps: string[];
  /** The expected outcomes: Then steps (Gherkin) or the Expected Result column. */
  expected: string[];
  /** Scenario Outline example rows (first 10), when present. */
  examples?: Array<Record<string, string>>;
  source: { file: string; line?: number; row?: number };
}

export interface ParseResult {
  cases: TestCase[];
  warnings: string[];
}

const ID_PATTERN = /^[A-Za-z]{1,10}[-_]?\d+$/;
const PRIORITY_PATTERN = /^(?:smoke|regression|sanity|critical|high|medium|low|p[0-4])$/i;

export function isIdTag(tag: string): boolean {
  return ID_PATTERN.test(tag);
}

export function isPriorityTag(tag: string): boolean {
  return PRIORITY_PATTERN.test(tag);
}

/** `login-flow.feature` + 3 -> `login-flow-3`, used when the author did not provide an ID. */
export function generatedId(fileName: string, position: number): string {
  const base = fileName.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "case";
  return `${slug}-${position}`;
}
