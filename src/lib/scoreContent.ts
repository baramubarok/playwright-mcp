import path from "node:path";
import ts from "typescript";
import { resolveProjectPath } from "./pathSecurity.js";
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

export interface ScaffoldStatus {
  /** True when the file is an unimplemented scaffold (explicit marker, or every test is test.fixme). */
  skeleton: boolean;
  /** TODO markers found in comments. */
  todoCount: number;
  /** Tests declared with test.fixme(...), which Playwright skips. */
  fixmeTests: number;
}

export interface ScoreContentResult {
  locatorQuality: { semanticPct: number; cssXpathCount: number; semanticCount: number; totalLocators: number };
  assertionDensity: { totalAssertions: number; testCount: number; perTestAvg: number };
  antiPatterns: AntiPatternCounts;
  scaffold: ScaffoldStatus;
  warnings: string[];
}

/** Comment marker written by scaffold_test_domain into generated skeleton specs. */
export const SKELETON_MARKER = "@mcp-skeleton";

const SEMANTIC_LOCATORS = new Set(["getByRole", "getByText", "getByLabel", "getByTestId", "getByPlaceholder", "getByAltText", "getByTitle"]);
const ACTIONS = new Set(["click", "fill", "check", "uncheck", "selectOption", "press", "type", "hover", "focus", "dblclick", "dragTo", "tap", "selectText", "setInputFiles", "pressSequentially", "clear"]);
const TEXT_EXTRACTION = new Set(["textContent", "innerText"]);
const TEST_MODIFIERS = new Set(["only", "skip", "fixme", "fail", "slow"]);
// Callbacks passed to these run inside the browser, where DOM methods like click() are synchronous.
const BROWSER_CONTEXT_CALLS = new Set(["evaluate", "evaluateHandle", "$eval", "$$eval", "addInitScript", "waitForFunction", "exposeFunction"]);

function emptyAntiPatterns(): AntiPatternCounts {
  return {
    waitForTimeout: 0,
    hardcodedSleep: 0,
    indexBasedLocator: 0,
    deepLocatorChain: 0,
    missingAwaitOnAction: 0,
    manualTextExtraction: 0,
    missingDescribeGrouping: 0,
    missingTestStep: 0,
  };
}

function calleeName(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
}

function receiverOf(call: ts.CallExpression): ts.Expression | undefined {
  return ts.isPropertyAccessExpression(call.expression) ? call.expression.expression : undefined;
}

/** `test`, `test.only`, `test.fixme`, … — returns the modifier ("" for plain test) or undefined. */
function testModifier(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee) && callee.text === "test") return "";
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "test" &&
    TEST_MODIFIERS.has(callee.name.text)
  ) {
    return callee.name.text;
  }
  return undefined;
}

function isStringLike(node: ts.Node | undefined): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateExpression {
  return node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node));
}

function isTestMember(call: ts.CallExpression, member: string): boolean {
  let callee: ts.Expression = call.expression;
  // Accept test.describe(...), test.describe.serial(...), test.describe.configure is excluded by name check.
  while (ts.isPropertyAccessExpression(callee)) {
    if (callee.name.text === member && ts.isIdentifier(callee.expression) && callee.expression.text === "test") return true;
    callee = callee.expression;
  }
  return false;
}

function countLocatorCallsInChain(expression: ts.Expression | undefined): number {
  let count = 0;
  let current = expression;
  while (current) {
    if (ts.isCallExpression(current)) {
      if (calleeName(current) === "locator" && receiverOf(current)) count++;
      current = receiverOf(current) ?? undefined;
    } else if (ts.isPropertyAccessExpression(current)) {
      current = current.expression;
    } else if (ts.isParenthesizedExpression(current) || ts.isAwaitExpression(current)) {
      current = current.expression;
    } else {
      current = undefined;
    }
  }
  return count;
}

function isFloating(call: ts.CallExpression): boolean {
  let node: ts.Node = call;
  while (ts.isParenthesizedExpression(node.parent)) node = node.parent;
  return ts.isExpressionStatement(node.parent);
}

function insideBrowserCallback(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current)) && ts.isCallExpression(current.parent)) {
      const name = calleeName(current.parent);
      if (name && BROWSER_CONTEXT_CALLS.has(name)) return true;
    }
    current = current.parent;
  }
  return false;
}

function isDeepSelector(selector: string): boolean {
  const trimmed = selector.trim();
  return />/.test(trimmed) || trimmed.startsWith("//") || /^xpath=/i.test(trimmed) || /\S\s+\S/.test(trimmed);
}

function scanComments(content: string): { todoCount: number; hasSkeletonMarker: boolean } {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, content);
  let todoCount = 0;
  let hasSkeletonMarker = false;
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) {
      const text = scanner.getTokenText();
      todoCount += text.match(/\bTODO\b/g)?.length ?? 0;
      if (text.includes(SKELETON_MARKER)) hasSkeletonMarker = true;
    }
  }
  return { todoCount, hasSkeletonMarker };
}

interface PendingWarning {
  line: number;
  order: number;
  message: string;
}

/**
 * Score Playwright source with the TypeScript AST, so comments, strings and template text are
 * never mistaken for locators, assertions or actions.
 */
export function scoreContent(content: string, fileName = "spec.ts"): ScoreContentResult {
  const scriptKind = /\.[jt]sx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true, scriptKind);
  const lineOf = (node: ts.Node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  let semanticCount = 0;
  let cssXpathCount = 0;
  let totalAssertions = 0;
  let testCount = 0;
  let fixmeTests = 0;
  let hasDescribe = false;
  let hasStep = false;
  const antiPatterns = emptyAntiPatterns();
  const pending: PendingWarning[] = [];
  const warn = (node: ts.Node, order: number, message: string) => pending.push({ line: lineOf(node), order, message });

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      const receiver = receiverOf(node);
      const modifier = testModifier(node);

      if (modifier !== undefined && isStringLike(node.arguments[0])) {
        testCount++;
        if (modifier === "fixme") fixmeTests++;
      }
      if (isTestMember(node, "describe")) hasDescribe = true;
      if (isTestMember(node, "step")) hasStep = true;

      if (name === "expect" && ts.isIdentifier(node.expression)) totalAssertions++;
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "expect" &&
        (name === "soft" || name === "poll")
      ) {
        totalAssertions++;
      }

      if (name && receiver && SEMANTIC_LOCATORS.has(name)) semanticCount++;

      if (name === "waitForTimeout" && receiver) {
        antiPatterns.waitForTimeout++;
        warn(node, 0, `uses waitForTimeout(...) — arbitrary sleeps are the most common cause of flaky tests; use a web-first assertion (expect(locator).toBeVisible()) or wait for the specific condition (waitForResponse/waitForURL) instead.`);
      }
      if (name === "setTimeout" && ts.isIdentifier(node.expression)) {
        antiPatterns.hardcodedSleep++;
        warn(node, 1, `uses setTimeout(...) as a manual sleep — same flakiness risk as waitForTimeout; wait on a specific condition instead.`);
      }
      if (name === "locator" && receiver) {
        cssXpathCount++;
        const selector = node.arguments[0];
        const selectorText = selector && (ts.isStringLiteral(selector) || ts.isNoSubstitutionTemplateLiteral(selector)) ? selector.text : "";
        warn(
          node,
          2,
          isDeepSelector(selectorText)
            ? `uses deep/nested CSS or XPath selector — highly fragile against DOM refactoring; prefer getByRole/getByText/getByTestId.`
            : `uses raw .locator(...) selector — prefer semantic locators (getByRole/getByTestId) unless targeting framework-portaled components (e.g. Vuetify modals).`,
        );
        const parentIsLocatorCall =
          ts.isPropertyAccessExpression(node.parent) && ts.isCallExpression(node.parent.parent) && calleeName(node.parent.parent) === "locator";
        if (!parentIsLocatorCall && countLocatorCallsInChain(node) >= 2) {
          antiPatterns.deepLocatorChain++;
          warn(node, 4, `chains multiple .locator(...) calls — deep chains are usually a sign the locator isn't specific enough.`);
        }
      }
      if (receiver && (name === "nth" || ((name === "first" || name === "last") && node.arguments.length === 0))) {
        antiPatterns.indexBasedLocator++;
        warn(node, 3, `uses .nth()/.first()/.last() — if targeting repeating cards/lists without IDs, ensure this is scoped within a parent container to reduce flakiness.`);
      }
      if (name && receiver && ACTIONS.has(name) && isFloating(node) && !insideBrowserCallback(node)) {
        antiPatterns.missingAwaitOnAction++;
        warn(node, 5, `calls an action (click/fill/check/...) without "await" — likely a missing await causing a race condition.`);
      }
      if (name && receiver && TEXT_EXTRACTION.has(name)) {
        antiPatterns.manualTextExtraction++;
        warn(node, 6, `uses .textContent()/.innerText() — manual text extraction doesn't auto-retry; prefer expect(locator).toHaveText()/.toContainText() for flake-resistant assertions.`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const totalLocators = semanticCount + cssXpathCount;
  const semanticPct = totalLocators > 0 ? Math.round((semanticCount / totalLocators) * 1000) / 10 : 0;
  const perTestAvg = testCount > 0 ? Math.round((totalAssertions / testCount) * 10) / 10 : 0;

  const warnings = pending
    .sort((left, right) => left.line - right.line || left.order - right.order)
    .map((warning) => `line ${warning.line}: ${warning.message}`);

  const comments = scanComments(content);
  const scaffold: ScaffoldStatus = {
    skeleton: comments.hasSkeletonMarker || (testCount > 0 && fixmeTests === testCount),
    todoCount: comments.todoCount,
    fixmeTests,
  };

  if (scaffold.skeleton) {
    warnings.unshift(
      `Unimplemented scaffold skeleton (${fixmeTests} test.fixme, ${comments.todoCount} TODO) — implement the TODOs, then replace test.fixme with test; until then the tests are skipped and prove nothing.`,
    );
  }

  if (testCount > 0 && totalAssertions === 0) {
    warnings.push("No expect() assertions found — tests may only exercise flows without verifying outcomes.");
  }

  if (testCount > 1 && !hasDescribe) {
    antiPatterns.missingDescribeGrouping = 1;
    warnings.push("Multiple tests but no test.describe(...) grouping — consider grouping related tests for a clearer report/trace structure.");
  }

  if (testCount > 0 && !hasStep) {
    antiPatterns.missingTestStep = 1;
    warnings.push("No test.step(...) found — consider wrapping key actions in test.step() for clearer trace segmentation when diagnosing failures.");
  }

  return {
    locatorQuality: { semanticPct, cssXpathCount, semanticCount, totalLocators },
    assertionDensity: { totalAssertions, testCount, perTestAvg },
    antiPatterns,
    scaffold,
    warnings,
  };
}

export interface ComprehensiveQualityScore extends ScoreContentResult {
  fileBreakdown?: Record<string, ScoreContentResult>;
}

export function findRelatedPOMFiles(entryFilePath: string, visited = new Set<string>(), projectRoot?: string): string[] {
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
        if (projectRoot) {
          try {
            resolveProjectPath(candidatePath, projectRoot);
          } catch {
            continue;
          }
        }
        if (existsSync(candidatePath) && !visited.has(candidatePath)) {
          results.push(...findRelatedPOMFiles(candidatePath, visited, projectRoot));
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
  const allFiles = findRelatedPOMFiles(entryFilePath, new Set<string>(), projectRoot);
  if (allFiles.length <= 1) {
    const content = readFileSync(entryFilePath, "utf-8");
    return scoreContent(content, entryFilePath);
  }

  const fileBreakdown: Record<string, ScoreContentResult> = {};
  let totalSemantic = 0;
  let totalCssXpath = 0;
  let totalAssertions = 0;
  let totalTests = 0;
  const combinedAntiPatterns = emptyAntiPatterns();
  const combinedScaffold: ScaffoldStatus = { skeleton: false, todoCount: 0, fixmeTests: 0 };
  const combinedWarnings: string[] = [];

  for (const filePath of allFiles) {
    const content = readFileSync(filePath, "utf-8");
    const fileScore = scoreContent(content, filePath);
    const relName = projectRoot ? path.relative(projectRoot, filePath) : path.basename(filePath);
    fileBreakdown[relName] = fileScore;

    totalSemantic += fileScore.locatorQuality.semanticCount;
    totalCssXpath += fileScore.locatorQuality.cssXpathCount;
    totalAssertions += fileScore.assertionDensity.totalAssertions;
    totalTests += fileScore.assertionDensity.testCount;
    combinedScaffold.skeleton ||= fileScore.scaffold.skeleton;
    combinedScaffold.todoCount += fileScore.scaffold.todoCount;
    combinedScaffold.fixmeTests += fileScore.scaffold.fixmeTests;

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
    scaffold: combinedScaffold,
    warnings: combinedWarnings,
    fileBreakdown,
  };
}
