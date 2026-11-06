import path from "node:path";
import ts from "typescript";
import { resolveProjectPath } from "./pathSecurity.js";
import { existsSync, readdirSync, readFileSync } from "node:fs";

export interface AntiPatternCounts {
  waitForTimeout: number;
  hardcodedSleep: number;
  indexBasedLocator: number;
  deepLocatorChain: number;
  missingAwaitOnAction: number;
  manualTextExtraction: number;
  missingDescribeGrouping: number;
  missingTestStep: number;
  /** Spec calls the API directly (request.post, page.request, fetch) instead of a domain *.api.ts helper. */
  inlineApiCall: number;
  /** Spec registers page.route()/context.route() instead of a domain *.mock.ts helper. */
  inlineRoute: number;
  /** A test tagged @integration that never uses an `*Api` fixture. */
  integrationWithoutApiHelper: number;
  /** Public methods of *.api.ts / *.mock.ts that no other related file calls (reported only for implemented specs). */
  unusedDomainHelpers: number;
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
// Helpers from tests/e2e/support/selectors.ts: stable data-testid / data-qa / data-{ID_SELECTOR} lookups.
const STABLE_ATTRIBUTE_HELPERS = new Set(["byTestId", "byQa", "byEnvId"]);
// A single data-* attribute selector such as [data-qa="submit"] is as stable as getByTestId.
const STABLE_DATA_ATTRIBUTE_SELECTOR = /^\[data-[a-z][a-z0-9-]*(?:=(?:"[^"]*"|'[^']*'|[^\]\s"']+))?\]$/i;
const ACTIONS = new Set(["click", "fill", "check", "uncheck", "selectOption", "press", "type", "hover", "focus", "dblclick", "dragTo", "tap", "selectText", "setInputFiles", "pressSequentially", "clear"]);
const TEXT_EXTRACTION = new Set(["textContent", "innerText"]);
const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "fetch"]);
const SPEC_FILE_NAME = /(?:^|[\\/.])(?:spec|test)\.[jt]sx?$/;
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
    inlineApiCall: 0,
    inlineRoute: 0,
    integrationWithoutApiHelper: 0,
    unusedDomainHelpers: 0,
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

/** `request`, `apiRequest`, `page.request`, `context.request`, `playwright.request`: direct HTTP clients. */
function isRequestReceiver(expression: ts.Expression): boolean {
  if (ts.isIdentifier(expression)) return /^(?:request|apiRequest|apiContext|requestContext)$/.test(expression.text);
  return ts.isPropertyAccessExpression(expression) && expression.name.text === "request";
}

/** True when the test callback destructures at least one `*Api` fixture. Unknown shapes are not flagged. */
function usesApiFixture(call: ts.CallExpression): boolean {
  const callback = [...call.arguments].reverse().find((argument) => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) as
    | ts.ArrowFunction
    | ts.FunctionExpression
    | undefined;
  if (!callback) return true;
  const firstParam = callback.parameters[0];
  if (!firstParam) return false;
  if (!ts.isObjectBindingPattern(firstParam.name)) return true;
  return firstParam.name.elements.some((element) => {
    const local = ts.isIdentifier(element.name) ? element.name.text : "";
    const property = element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName.text : "";
    return /Api$/.test(local) || /Api$/.test(property);
  });
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
  // Direct API/route use is only a problem in specs; domain *.api.ts / *.mock.ts files are where it belongs.
  const isSpecFile = SPEC_FILE_NAME.test(fileName);

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
        if (isSpecFile && node.arguments[0].getText(sourceFile).includes("@integration") && !usesApiFixture(node)) {
          antiPatterns.integrationWithoutApiHelper++;
          warn(node, 7, `is tagged @integration but uses no *Api fixture — integration tests must arrange and verify state through the domain *.api.ts helper (add the method there if it is missing).`);
        }
      }
      if (isTestMember(node, "describe")) hasDescribe = true;
      if (isTestMember(node, "step")) hasStep = true;

      if (isSpecFile && receiver) {
        if (HTTP_METHODS.has(name ?? "") && isRequestReceiver(receiver)) {
          antiPatterns.inlineApiCall++;
          warn(node, 8, `calls the API directly in the spec (${receiver.getText(sourceFile)}.${name}(...)) — add a method to the domain *.api.ts and call it through the *Api fixture so helpers stay reusable.`);
        } else if (name === "newContext" && isRequestReceiver(receiver)) {
          antiPatterns.inlineApiCall++;
          warn(node, 8, `creates an API request context in the spec — the *Api fixture already provides an authenticated, API_URL based context.`);
        } else if (name === "route") {
          antiPatterns.inlineRoute++;
          warn(node, 9, `registers ${receiver.getText(sourceFile)}.route(...) in the spec — add a method to the domain *.mock.ts and call it through the *Mock fixture.`);
        }
      }
      if (isSpecFile && name === "fetch" && !receiver && ts.isIdentifier(node.expression)) {
        antiPatterns.inlineApiCall++;
        warn(node, 8, `calls fetch(...) in the spec — add a method to the domain *.api.ts and call it through the *Api fixture.`);
      }

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
      if (name && !receiver && ts.isIdentifier(node.expression) && STABLE_ATTRIBUTE_HELPERS.has(name)) semanticCount++;

      if (name === "waitForTimeout" && receiver) {
        antiPatterns.waitForTimeout++;
        warn(node, 0, `uses waitForTimeout(...) — arbitrary sleeps are the most common cause of flaky tests; use a web-first assertion (expect(locator).toBeVisible()) or wait for the specific condition (waitForResponse/waitForURL) instead.`);
      }
      if (name === "setTimeout" && ts.isIdentifier(node.expression)) {
        antiPatterns.hardcodedSleep++;
        warn(node, 1, `uses setTimeout(...) as a manual sleep — same flakiness risk as waitForTimeout; wait on a specific condition instead.`);
      }
      if (name === "locator" && receiver) {
        const selector = node.arguments[0];
        const selectorText = selector && (ts.isStringLiteral(selector) || ts.isNoSubstitutionTemplateLiteral(selector)) ? selector.text : "";
        if (selectorText && STABLE_DATA_ATTRIBUTE_SELECTOR.test(selectorText.trim())) {
          semanticCount++;
        } else {
          cssXpathCount++;
          warn(
            node,
            2,
            isDeepSelector(selectorText)
              ? `uses deep/nested CSS or XPath selector — highly fragile against DOM refactoring; prefer data-testid/data-qa attributes, then getByRole/getByText.`
              : `uses raw .locator(...) selector — prefer data-testid/data-qa attributes or semantic locators (getByRole/getByLabel) unless targeting framework-portaled components (e.g. Vuetify modals).`,
          );
          const parentIsLocatorCall =
            ts.isPropertyAccessExpression(node.parent) && ts.isCallExpression(node.parent.parent) && calleeName(node.parent.parent) === "locator";
          if (!parentIsLocatorCall && countLocatorCallsInChain(node) >= 2) {
            antiPatterns.deepLocatorChain++;
            warn(node, 4, `chains multiple .locator(...) calls — deep chains are usually a sign the locator isn't specific enough.`);
          }
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

const DOMAIN_HELPER_FILE = /\.(?:api|mock)\.[jt]s$/;

function parseSource(content: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true, /\.[jt]sx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

/** Public (not private/protected, not `_`-prefixed) methods declared by classes in a domain helper file. */
function collectPublicMethods(sourceFile: ts.SourceFile): string[] {
  const methods: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node)) {
      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member) || !ts.isIdentifier(member.name)) continue;
        const modifiers = ts.getModifiers(member) ?? [];
        const hidden = modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword || modifier.kind === ts.SyntaxKind.ProtectedKeyword);
        if (!hidden && !member.name.text.startsWith("_")) methods.push(member.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return methods;
}

/** Names used as `something.name` anywhere in real code (comments and strings are ignored). */
function collectAccessedNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node)) names.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return names;
}

/**
 * Domain helpers that no other related file calls are dead weight and a sign the spec re-implemented
 * them inline. Skipped for skeletons, whose reference examples intentionally cover more than the tests call.
 */
function findUnusedDomainHelpers(files: string[], contents: Map<string, string>): Array<{ file: string; methods: string[] }> {
  const parsed = new Map(files.map((file) => [file, parseSource(contents.get(file) ?? "", file)]));
  const accessed = new Map([...parsed].map(([file, source]) => [file, collectAccessedNames(source)]));
  const unused: Array<{ file: string; methods: string[] }> = [];
  for (const file of files.filter((candidate) => DOMAIN_HELPER_FILE.test(candidate))) {
    const methods = collectPublicMethods(parsed.get(file)!).filter(
      (method) => !files.some((other) => other !== file && accessed.get(other)?.has(method)),
    );
    if (methods.length > 0) unused.push({ file, methods });
  }
  return unused;
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

export function findSpecFilesInDirectory(directoryPath: string, maxFiles = 50): string[] {
  const results: string[] = [];
  function walk(currentDir: string): void {
    if (results.length >= maxFiles || !existsSync(currentDir)) return;
    try {
      const entries = readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= maxFiles) break;
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "node_modules" && !entry.name.startsWith(".")) {
            walk(fullPath);
          }
        } else if (entry.isFile() && /\.(?:spec|test)\.[jt]sx?$/.test(entry.name)) {
          results.push(fullPath);
        }
      }
    } catch {
      // Ignore directory read errors
    }
  }
  walk(directoryPath);
  return results;
}

export function scoreSpecFiles(entryFilePaths: string[], projectRoot?: string): ComprehensiveQualityScore {
  const visited = new Set<string>();
  const allFiles: string[] = [];
  for (const entry of entryFilePaths) {
    if (existsSync(entry)) {
      allFiles.push(...findRelatedPOMFiles(entry, visited, projectRoot));
    }
  }

  if (allFiles.length === 0) {
    return {
      locatorQuality: { semanticPct: 0, cssXpathCount: 0, semanticCount: 0, totalLocators: 0 },
      assertionDensity: { totalAssertions: 0, testCount: 0, perTestAvg: 0 },
      antiPatterns: emptyAntiPatterns(),
      scaffold: { skeleton: false, todoCount: 0, fixmeTests: 0 },
      warnings: [],
    };
  }

  if (allFiles.length <= 1) {
    const singleFile = allFiles[0];
    const content = readFileSync(singleFile, "utf-8");
    return scoreContent(content, singleFile);
  }

  const fileBreakdown: Record<string, ScoreContentResult> = {};
  let totalSemantic = 0;
  let totalCssXpath = 0;
  let totalAssertions = 0;
  let totalTests = 0;
  const combinedAntiPatterns = emptyAntiPatterns();
  const combinedScaffold: ScaffoldStatus = { skeleton: false, todoCount: 0, fixmeTests: 0 };
  const combinedWarnings: string[] = [];
  const contents = new Map<string, string>();

  for (const filePath of allFiles) {
    const content = readFileSync(filePath, "utf-8");
    contents.set(filePath, content);
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

  if (!combinedScaffold.skeleton) {
    for (const { file, methods } of findUnusedDomainHelpers(allFiles, contents)) {
      combinedAntiPatterns.unusedDomainHelpers += methods.length;
      const relName = projectRoot ? path.relative(projectRoot, file) : path.basename(file);
      combinedWarnings.push(`[${relName}] unused helper method(s): ${methods.join(", ")} — call them from the spec through the fixture, or remove them if they are not needed.`);
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

export function scoreSpecAndRelatedPOMFiles(entryFilePath: string, projectRoot?: string): ComprehensiveQualityScore {
  return scoreSpecFiles([entryFilePath], projectRoot);
}
