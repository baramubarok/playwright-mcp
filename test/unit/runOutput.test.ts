import assert from "node:assert/strict";
import test from "node:test";
import { fitToBudget, OUTPUT_BUDGET } from "../../src/lib/runOutput.js";
import type { TestFailureDetail } from "../../src/lib/playwrightReport.js";

const failure = (index: number): TestFailureDetail => ({
  testId: `id-${index}`,
  testTitle: `test ${index}`,
  errorType: "assertion_failed",
  errorMessage: "x".repeat(5_000),
  recentSteps: ["a", "b", "c", "d", "e"],
  consoleErrors: Array.from({ length: 5 }, (_, item) => `[error] ${"c".repeat(200)} ${item}`),
});

test("fitToBudget terminates and stays within the cap for oversized payloads", () => {
  const output = fitToBudget(
    {
      failures: Array.from({ length: 5 }, (_, index) => failure(index)),
      tests: Array.from({ length: 20 }, (_, index) => ({ testId: `t${index}`, title: "t".repeat(300), status: "failed" as const, durationMs: 1, retries: 0 })),
      qualityScore: { semanticPct: 0, totalLocators: 0, totalAssertions: 0, testCount: 0, assertionsPerTest: 0, antiPatternTotal: 0, topWarnings: ["w".repeat(500)] },
    },
    "summary",
  );
  assert.ok(JSON.stringify(output).length <= OUTPUT_BUDGET.summary.maxChars);
  assert.equal(output.outputBudget?.reduced, true);
  assert.ok((output.failures?.length ?? 0) >= 1, "the first failure is always kept");
});

test("fitToBudget shortens all failures before dropping any", () => {
  const output = fitToBudget({ failures: [failure(1), failure(2)], tests: [] }, "summary");
  assert.equal(output.failures?.length, 2);
  assert.equal(output.failuresOmitted, undefined);
});
