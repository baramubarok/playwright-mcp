import type { ComprehensiveQualityScore } from "./scoreContent.js";
import type { FlatSpecResult, TestFailureDetail } from "./playwrightReport.js";
import { tailText, truncateText } from "./text.js";

export type DetailLevel = "summary" | "full";

/**
 * Documented payload budgets (characters of compact JSON). `summary` is the default for
 * run_playwright_test and targets ~800–1,200 tokens for a typical failing run; the hard cap keeps
 * even very large suites bounded. `full` is opt-in and is still bounded.
 */
export const OUTPUT_BUDGET = {
  summary: {
    maxChars: 6_000,
    failures: 5,
    tests: 20,
    errorMessageChars: 1_500,
    callLogChars: 600,
    diagnosticsPerKind: 5,
    runnerMessageChars: 1_500,
    stderrTailChars: 1_000,
    attemptErrorChars: 0,
    qualityWarnings: 5,
  },
  full: {
    maxChars: 100_000,
    failures: 10,
    tests: 200,
    errorMessageChars: 4_000,
    callLogChars: 2_000,
    attemptErrorChars: 200,
    diagnosticsPerKind: 20,
    runnerMessageChars: 4_000,
    stderrTailChars: 8_000,
    qualityWarnings: 50,
  },
} as const;

type Budget = (typeof OUTPUT_BUDGET)[DetailLevel];

export interface CompactTest {
  testId: string;
  title: string;
  fullTitle?: string;
  projectName?: string;
  status: FlatSpecResult["status"];
  durationMs: number;
  retries: number;
  errorType?: string;
  attempts?: Array<{ retry: number; status: string; durationMs: number; errorMessage?: string; attachments: Array<{ name: string; path?: string; contentType: string }> }>;
}

export interface CompactQualityScore {
  semanticPct: number;
  totalLocators: number;
  totalAssertions: number;
  testCount: number;
  assertionsPerTest: number;
  antiPatternTotal: number;
  skeleton?: boolean;
  topWarnings: string[];
  warningsOmitted?: number;
}

export function shapeFailure(detail: TestFailureDetail, level: DetailLevel): TestFailureDetail {
  const budget: Budget = OUTPUT_BUDGET[level];
  const limit = <T>(values: T[] | undefined): T[] | undefined => (values && values.length > 0 ? values.slice(0, budget.diagnosticsPerKind) : undefined);
  const { healingGateDirective: _directive, ...rest } = detail;
  return {
    ...rest,
    errorMessage: truncateText(detail.errorMessage, budget.errorMessageChars),
    // In summary mode the call log is already part of errorMessage; repeating it wastes tokens.
    callLogExcerpt: level === "full" && detail.callLogExcerpt ? truncateText(detail.callLogExcerpt, budget.callLogChars) : undefined,
    consoleErrors: limit(detail.consoleErrors),
    pageErrors: limit(detail.pageErrors),
    networkErrors: limit(detail.networkErrors),
  };
}

export function shapeTests(tests: FlatSpecResult[], level: DetailLevel): { tests: CompactTest[]; omitted: number } {
  const budget: Budget = OUTPUT_BUDGET[level];
  // Summary mode lists only tests that need attention; counts already cover the passing ones.
  const candidates = level === "summary" ? tests.filter((test) => test.status !== "passed" && test.status !== "skipped") : tests;
  const selected = candidates.slice(0, budget.tests).map((test): CompactTest => ({
    testId: test.testId,
    title: test.title,
    ...(test.fullTitle !== test.title ? { fullTitle: test.fullTitle } : {}),
    ...(test.projectName ? { projectName: test.projectName } : {}),
    status: test.status,
    durationMs: test.durationMs,
    retries: test.retries,
    ...(test.errorType ? { errorType: test.errorType } : {}),
    ...(level === "full"
      ? {
          attempts: test.attempts.map((attempt) => ({
            ...attempt,
            errorMessage: attempt.errorMessage ? truncateText(attempt.errorMessage, budget.attemptErrorChars) : undefined,
            attachments: attempt.attachments.map(({ name, path, contentType }) => ({ name, path, contentType })),
          })),
        }
      : {}),
  }));
  return { tests: selected, omitted: candidates.length - selected.length };
}

export function compactQualityScore(score: ComprehensiveQualityScore, level: DetailLevel): CompactQualityScore {
  const budget: Budget = OUTPUT_BUDGET[level];
  const antiPatternTotal = Object.values(score.antiPatterns).reduce((sum, value) => sum + value, 0);
  return {
    semanticPct: score.locatorQuality.semanticPct,
    totalLocators: score.locatorQuality.totalLocators,
    totalAssertions: score.assertionDensity.totalAssertions,
    testCount: score.assertionDensity.testCount,
    assertionsPerTest: score.assertionDensity.perTestAvg,
    antiPatternTotal,
    ...(score.scaffold?.skeleton ? { skeleton: true } : {}),
    topWarnings: score.warnings.slice(0, budget.qualityWarnings),
    ...(score.warnings.length > budget.qualityWarnings ? { warningsOmitted: score.warnings.length - budget.qualityWarnings } : {}),
  };
}

export function boundRunnerText(value: string, level: DetailLevel, kind: "message" | "stderr"): string {
  const budget: Budget = OUTPUT_BUDGET[level];
  return kind === "message" ? truncateText(value, budget.runnerMessageChars) : tailText(value, budget.stderrTailChars);
}

/**
 * Shorten failures in place. Returns true only when something actually got smaller, so the budget
 * loop always terminates (truncateText appends a marker, so a length threshold alone never settles).
 */
function shrinkFailures(failures: TestFailureDetail[], messageChars: number, listItems: number): boolean {
  let changed = false;
  const shrinkList = <T>(values: T[] | undefined): T[] | undefined => {
    if (!values || values.length <= listItems) return values;
    changed = true;
    return values.slice(0, listItems);
  };
  for (const failure of failures) {
    const shortened = truncateText(failure.errorMessage, messageChars);
    if (shortened.length < failure.errorMessage.length) {
      failure.errorMessage = shortened;
      changed = true;
    }
    if (failure.recentSteps && failure.recentSteps.length > listItems) {
      failure.recentSteps = failure.recentSteps.slice(-listItems);
      changed = true;
    }
    failure.consoleErrors = shrinkList(failure.consoleErrors);
    failure.networkErrors = shrinkList(failure.networkErrors);
    failure.pageErrors = shrinkList(failure.pageErrors);
  }
  return changed;
}

interface BudgetedOutput {
  failures?: TestFailureDetail[];
  failuresOmitted?: number;
  tests: CompactTest[];
  testsOmitted?: number;
  qualityScore?: CompactQualityScore | ComprehensiveQualityScore;
  outputBudget?: { maxChars: number; reduced: boolean };
}

/**
 * Enforce the hard character cap by shedding the least important detail first. The status, counts,
 * runner error and artifact paths are never removed.
 */
export function fitToBudget<T extends BudgetedOutput>(output: T, level: DetailLevel): T {
  const maxChars = OUTPUT_BUDGET[level].maxChars;
  const size = (): number => JSON.stringify(output).length;
  output.outputBudget = { maxChars, reduced: false };
  const reducers: Array<() => boolean> = [
    () => {
      if (!output.qualityScore || !("topWarnings" in output.qualityScore) || output.qualityScore.topWarnings.length === 0) return false;
      output.qualityScore.warningsOmitted = (output.qualityScore.warningsOmitted ?? 0) + output.qualityScore.topWarnings.length;
      output.qualityScore.topWarnings = [];
      return true;
    },
    () => {
      if (output.tests.length <= 3) return false;
      const keep = Math.max(3, Math.floor(output.tests.length / 2));
      output.testsOmitted = (output.testsOmitted ?? 0) + output.tests.length - keep;
      output.tests = output.tests.slice(0, keep);
      return true;
    },
    // Shorten every failure before dropping any, so the response keeps its breadth.
    () => shrinkFailures(output.failures ?? [], 600, 3),
    () => {
      if (!output.failures || output.failures.length <= 1) return false;
      output.failures = output.failures.slice(0, -1);
      output.failuresOmitted = (output.failuresOmitted ?? 0) + 1;
      return true;
    },
    () => shrinkFailures(output.failures?.slice(0, 1) ?? [], 300, 1),
  ];
  for (const reduce of reducers) {
    while (size() > maxChars && reduce()) output.outputBudget.reduced = true;
  }
  return output;
}
