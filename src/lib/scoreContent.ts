import path from "node:path";
import { existsSync, readFileSync } from "node:fs";

export interface AntiPatternCounts {
  waitForTimeout: number;
  hardcodedSleep: number;
  indexBasedLocator: number;
  deepLocatorChain: number;
  missingAwaitOnAction: number;
  manualTextExtraction: number;
  missingDescribeGrouping: number;
  missingTestStep: number;
}

export interface ScoreContentResult {
  locatorQuality: { semanticPct: number; cssXpathCount: number; semanticCount: number; totalLocators: number };
  assertionDensity: { totalAssertions: number; testCount: number; perTestAvg: number };
  antiPatterns: AntiPatternCounts;
  warnings: string[];
}

const SEMANTIC_LOCATOR_RE = /\.getBy(Role|Text|Label|TestId|Placeholder|AltText|Title)\(/g;
const RAW_LOCATOR_RE = /\.locator\(/g;
const ASSERTION_RE = /\bexpect(?:\.soft)?\(/g;
const TEST_BLOCK_RE = /\btest(?:\.only|\.skip)?\(\s*["'`]/g;

// Flakiness-relevant anti-patterns. See RESEARCH_CONTEXT.md "Skema best
// practice" for why each of these was picked as auto-enforceable (regex/
// heuristic) rather than left as prompt-only guidance.
const WAIT_FOR_TIMEOUT_RE = /\.waitForTimeout\s*\(/g;
const HARDCODED_SLEEP_RE = /setTimeout\s*\(/g;
const INDEX_LOCATOR_RE = /\.(nth|first|last)\(/g;
const ACTION_CALL_RE = /\.(click|fill|check|uncheck|selectOption|press|type|hover|focus|dblclick|dragTo|tap|selectText)\s*\(/;
const MANUAL_TEXT_EXTRACTION_RE = /\.(textContent|innerText)\s*\(/g;

function countMatches(content: string, re: RegExp): number {
  return content.match(re)?.length ?? 0;
}

export function scoreContent(content: string): ScoreContentResult {
  const lines = content.split(/\r?\n/);

  const semanticCount = countMatches(content, SEMANTIC_LOCATOR_RE);
  const cssXpathCount = countMatches(content, RAW_LOCATOR_RE);
  const totalLocators = semanticCount + cssXpathCount;
  const semanticPct = totalLocators > 0 ? Math.round((semanticCount / totalLocators) * 1000) / 10 : 0;

  const totalAssertions = countMatches(content, ASSERTION_RE);
  const testCount = countMatches(content, TEST_BLOCK_RE);
  const perTestAvg = testCount > 0 ? Math.round((totalAssertions / testCount) * 10) / 10 : 0;

  const warnings: string[] = [];
  const antiPatterns: AntiPatternCounts = {
    waitForTimeout: 0,
    hardcodedSleep: 0,
    indexBasedLocator: 0,
    deepLocatorChain: 0,
    missingAwaitOnAction: 0,
    manualTextExtraction: 0,
    missingDescribeGrouping: 0,
    missingTestStep: 0,
  };

  lines.forEach((line, idx) => {
    const lineNo = idx + 1;

    if (WAIT_FOR_TIMEOUT_RE.test(line)) {
      antiPatterns.waitForTimeout++;
      warnings.push(
        `line ${lineNo}: uses waitForTimeout(...) — arbitrary sleeps are the most common cause of flaky tests; use a web-first assertion (expect(locator).toBeVisible()) or wait for the specific condition (waitForResponse/waitForURL) instead.`
      );
    }
    WAIT_FOR_TIMEOUT_RE.lastIndex = 0;

    if (HARDCODED_SLEEP_RE.test(line)) {
      antiPatterns.hardcodedSleep++;
      warnings.push(`line ${lineNo}: uses setTimeout(...) as a manual sleep — same flakiness risk as waitForTimeout; wait on a specific condition instead.`);
    }
    HARDCODED_SLEEP_RE.lastIndex = 0;

    if (RAW_LOCATOR_RE.test(line)) {
      if (/>|\s\w+\s|\/\//.test(line)) {
        warnings.push(
          `line ${lineNo}: uses deep/nested CSS or XPath selector — highly fragile against DOM refactoring; prefer getByRole/getByText/getByTestId.`
        );
      } else {
        warnings.push(
          `line ${lineNo}: uses raw .locator(...) selector — prefer semantic locators (getByRole/getByTestId) unless targeting framework-portaled components (e.g. Vuetify modals).`
        );
      }
    }
    RAW_LOCATOR_RE.lastIndex = 0;

    const indexMatches = line.match(INDEX_LOCATOR_RE)?.length ?? 0;
    if (indexMatches > 0) {
      antiPatterns.indexBasedLocator += indexMatches;
      warnings.push(
        `line ${lineNo}: uses .nth()/.first()/.last() — if targeting repeating cards/lists without IDs, ensure this is scoped within a parent container to reduce flakiness.`
      );
    }

    const locatorCallsOnLine = line.match(RAW_LOCATOR_RE)?.length ?? 0;
    RAW_LOCATOR_RE.lastIndex = 0;
    if (locatorCallsOnLine >= 2) {
      antiPatterns.deepLocatorChain++;
      warnings.push(`line ${lineNo}: chains multiple .locator(...) calls — deep chains are usually a sign the locator isn't specific enough.`);
    }

    if (ACTION_CALL_RE.test(line) && !/\bawait\b/.test(line) && !/^\s*\./.test(line)) {
      antiPatterns.missingAwaitOnAction++;
      warnings.push(`line ${lineNo}: calls an action (click/fill/check/...) without an "await" on the line — likely a missing await causing a race condition.`);
    }

    const textExtractionMatches = line.match(MANUAL_TEXT_EXTRACTION_RE)?.length ?? 0;
    if (textExtractionMatches > 0) {
      antiPatterns.manualTextExtraction += textExtractionMatches;
      warnings.push(
        `line ${lineNo}: uses .textContent()/.innerText() — manual text extraction doesn't auto-retry; prefer expect(locator).toHaveText()/.toContainText() for flake-resistant assertions.`
      );
    }
  });

  if (testCount > 0 && totalAssertions === 0) {
    warnings.push("No expect() assertions found — tests may only exercise flows without verifying outcomes.");
  }

  if (testCount > 1 && !/\btest\.describe\(/.test(content)) {
    antiPatterns.missingDescribeGrouping = 1;
    warnings.push("Multiple tests but no test.describe(...) grouping — consider grouping related tests for a clearer report/trace structure.");
  }

  if (testCount > 0 && !/\btest\.step\(/.test(content)) {
    antiPatterns.missingTestStep = 1;
    warnings.push("No test.step(...) found — consider wrapping key actions in test.step() for clearer trace segmentation when diagnosing failures.");
  }

  return {
    locatorQuality: { semanticPct, cssXpathCount, semanticCount, totalLocators },
    assertionDensity: { totalAssertions, testCount, perTestAvg },
    antiPatterns,
    warnings,
  };
}

export interface ComprehensiveQualityScore extends ScoreContentResult {
  fileBreakdown?: Record<string, ScoreContentResult>;
}

export function findRelatedPOMFiles(entryFilePath: string, visited = new Set<string>()): string[] {
  if (visited.has(entryFilePath) || !existsSync(entryFilePath)) return [];
  visited.add(entryFilePath);

  const results: string[] = [entryFilePath];
  try {
    const content = readFileSync(entryFilePath, "utf-8");
    const dir = path.dirname(entryFilePath);

    // Find relative import statements
    const importMatches = content.matchAll(/(?:import|from)\s+['"](\.[^'"]+)['"]/g);
    for (const match of importMatches) {
      const importRel = match[1];
      const candidateExtensions = ["", ".ts", ".js", ".tsx", ".jsx", "/index.ts", "/index.js"];
      for (const ext of candidateExtensions) {
        const candidatePath = path.resolve(dir, importRel + ext);
        if (existsSync(candidatePath) && !visited.has(candidatePath)) {
          results.push(...findRelatedPOMFiles(candidatePath, visited));
          break;
        }
      }
    }
  } catch {
    // Ignore read errors on import resolution
  }

  return results;
}

export function scoreSpecAndRelatedPOMFiles(entryFilePath: string, projectRoot?: string): ComprehensiveQualityScore {
  const allFiles = findRelatedPOMFiles(entryFilePath);
  if (allFiles.length <= 1) {
    const content = readFileSync(entryFilePath, "utf-8");
    return scoreContent(content);
  }

  const fileBreakdown: Record<string, ScoreContentResult> = {};
  let totalSemantic = 0;
  let totalCssXpath = 0;
  let totalAssertions = 0;
  let totalTests = 0;
  const combinedAntiPatterns: AntiPatternCounts = {
    waitForTimeout: 0,
    hardcodedSleep: 0,
    indexBasedLocator: 0,
    deepLocatorChain: 0,
    missingAwaitOnAction: 0,
    manualTextExtraction: 0,
    missingDescribeGrouping: 0,
    missingTestStep: 0,
  };
  const combinedWarnings: string[] = [];

  for (const filePath of allFiles) {
    const content = readFileSync(filePath, "utf-8");
    const fileScore = scoreContent(content);
    const relName = projectRoot ? path.relative(projectRoot, filePath) : path.basename(filePath);
    fileBreakdown[relName] = fileScore;

    totalSemantic += fileScore.locatorQuality.semanticCount;
    totalCssXpath += fileScore.locatorQuality.cssXpathCount;
    totalAssertions += fileScore.assertionDensity.totalAssertions;
    totalTests += fileScore.assertionDensity.testCount;

    for (const key of Object.keys(combinedAntiPatterns) as Array<keyof AntiPatternCounts>) {
      combinedAntiPatterns[key] += fileScore.antiPatterns[key];
    }

    for (const w of fileScore.warnings) {
      combinedWarnings.push(`[${relName}] ${w}`);
    }
  }

  const totalLocators = totalSemantic + totalCssXpath;
  const semanticPct = totalLocators > 0 ? Math.round((totalSemantic / totalLocators) * 1000) / 10 : 0;
  const perTestAvg = totalTests > 0 ? Math.round((totalAssertions / totalTests) * 10) / 10 : 0;

  return {
    locatorQuality: {
      semanticPct,
      cssXpathCount: totalCssXpath,
      semanticCount: totalSemantic,
      totalLocators,
    },
    assertionDensity: {
      totalAssertions,
      testCount: totalTests,
      perTestAvg,
    },
    antiPatterns: combinedAntiPatterns,
    warnings: combinedWarnings,
    fileBreakdown,
  };
}

