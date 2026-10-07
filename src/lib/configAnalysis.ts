import ts from "typescript";

export type SettingKind = "literal" | "expression" | "missing";

export interface SettingDetail {
  /** Source text of the value, e.g. `process.env.CI ? 2 : 0` or `'on-first-retry'`. */
  value?: string;
  kind: SettingKind;
  line?: number;
  /** "project" when the value was only found in a projects[].use block. */
  scope?: "config" | "project";
}

export interface ReporterAnalysis {
  detected: string[];
  html: boolean;
  json: boolean;
  allure: boolean;
  /** False when the reporter list is a runtime expression and cannot be read statically. */
  determinable: boolean;
}

export interface ConfigAnalysis {
  found: boolean;
  settings: Record<string, SettingDetail>;
  reporters: ReporterAnalysis;
  limitations: string[];
}

export const TOP_LEVEL_SETTINGS = ["retries", "workers", "fullyParallel", "forbidOnly", "reporter"] as const;
export const USE_SETTINGS = ["trace", "screenshot", "video"] as const;

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function findVariableInitializer(sourceFile: ts.SourceFile, name: string): ts.Expression | undefined {
  let initializer: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (initializer) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) {
      initializer = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return initializer;
}

/** Resolve `defineConfig({...}, {...})`, object literals and same-file identifiers to object literals. */
function resolveConfigObjects(sourceFile: ts.SourceFile, expression: ts.Expression, depth = 0): ts.ObjectLiteralExpression[] {
  if (depth > 5) return [];
  const node = unwrap(expression);
  if (ts.isObjectLiteralExpression(node)) return [node];
  if (ts.isIdentifier(node)) {
    const initializer = findVariableInitializer(sourceFile, node.text);
    return initializer ? resolveConfigObjects(sourceFile, initializer, depth + 1) : [];
  }
  if (ts.isCallExpression(node)) {
    return node.arguments.flatMap((argument) => resolveConfigObjects(sourceFile, argument, depth + 1));
  }
  return [];
}

function findExportedConfig(sourceFile: ts.SourceFile): ts.ObjectLiteralExpression[] {
  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement)) return resolveConfigObjects(sourceFile, statement.expression);
    if (
      ts.isExpressionStatement(statement) &&
      ts.isBinaryExpression(statement.expression) &&
      statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      statement.expression.left.getText(sourceFile) === "module.exports"
    ) {
      return resolveConfigObjects(sourceFile, statement.expression.right);
    }
  }
  return [];
}

function propertyName(property: ts.ObjectLiteralElementLike): string | undefined {
  if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return undefined;
  const name = property.name;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
}

function isStaticLiteral(node: ts.Expression): boolean {
  const value = unwrap(node);
  if (
    ts.isStringLiteral(value) ||
    ts.isNoSubstitutionTemplateLiteral(value) ||
    ts.isNumericLiteral(value) ||
    value.kind === ts.SyntaxKind.TrueKeyword ||
    value.kind === ts.SyntaxKind.FalseKeyword ||
    value.kind === ts.SyntaxKind.NullKeyword
  ) {
    return true;
  }
  if (ts.isPrefixUnaryExpression(value) && ts.isNumericLiteral(value.operand)) return true;
  if (ts.isArrayLiteralExpression(value)) return value.elements.every((element) => !ts.isSpreadElement(element) && isStaticLiteral(element));
  if (ts.isObjectLiteralExpression(value)) {
    return value.properties.every((property) => ts.isPropertyAssignment(property) && isStaticLiteral(property.initializer));
  }
  return false;
}

interface ObjectReadResult {
  properties: Map<string, ts.Expression>;
  hasSpread: boolean;
}

function readObject(objects: ts.ObjectLiteralExpression[]): ObjectReadResult {
  const properties = new Map<string, ts.Expression>();
  let hasSpread = false;
  // Later objects (defineConfig overrides) win, like Playwright's own merge.
  for (const object of objects) {
    for (const property of object.properties) {
      if (ts.isSpreadAssignment(property)) {
        hasSpread = true;
        continue;
      }
      const name = propertyName(property);
      if (!name) continue;
      properties.set(name, ts.isPropertyAssignment(property) ? property.initializer : (property as ts.ShorthandPropertyAssignment).name);
    }
  }
  return { properties, hasSpread };
}

function detail(sourceFile: ts.SourceFile, value: ts.Expression, scope: "config" | "project"): SettingDetail {
  return {
    value: value.getText(sourceFile),
    kind: isStaticLiteral(value) ? "literal" : "expression",
    line: sourceFile.getLineAndCharacterOfPosition(value.getStart(sourceFile)).line + 1,
    ...(scope === "project" ? { scope } : {}),
  };
}

function reporterNames(sourceFile: ts.SourceFile, value: ts.Expression | undefined): { names: string[]; determinable: boolean } {
  if (!value) return { names: [], determinable: true };
  const node = unwrap(value);
  const literalText = (element: ts.Expression): string | undefined => {
    const inner = unwrap(element);
    return ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner) ? inner.text : undefined;
  };
  const single = literalText(node);
  if (single !== undefined) return { names: [single], determinable: true };
  if (!ts.isArrayLiteralExpression(node)) return { names: [], determinable: false };
  const names: string[] = [];
  let determinable = true;
  for (const element of node.elements) {
    const entry = unwrap(element as ts.Expression);
    const direct = literalText(entry);
    if (direct !== undefined) {
      names.push(direct);
    } else if (ts.isArrayLiteralExpression(entry) && entry.elements[0] && literalText(entry.elements[0] as ts.Expression) !== undefined) {
      names.push(literalText(entry.elements[0] as ts.Expression)!);
    } else {
      determinable = false;
      names.push(`<expression: ${entry.getText(sourceFile).slice(0, 60)}>`);
    }
  }
  return { names, determinable };
}

/**
 * Statically analyze a Playwright config without executing it. Values computed at runtime
 * (environment variables, helpers, imports) are reported as `expression` instead of being guessed.
 */
export function analyzePlaywrightConfig(content: string, fileName = "playwright.config.ts"): ConfigAnalysis {
  const sourceFile = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const limitations: string[] = [];
  const objects = findExportedConfig(sourceFile);
  const settings: Record<string, SettingDetail> = {};
  if (objects.length === 0) {
    limitations.push("The exported config object could not be located statically (e.g. it is built by a function or imported).");
    for (const key of [...TOP_LEVEL_SETTINGS, ...USE_SETTINGS]) settings[key] = { kind: "missing" };
    return { found: false, settings, reporters: { detected: [], html: false, json: false, allure: false, determinable: false }, limitations };
  }

  const top = readObject(objects);
  if (top.hasSpread) limitations.push("The config object uses spread syntax; settings missing here may be provided by the spread value.");

  for (const key of TOP_LEVEL_SETTINGS) {
    const value = top.properties.get(key);
    settings[key] = value ? detail(sourceFile, value, "config") : { kind: "missing" };
  }

  const useValue = top.properties.get("use");
  const useObjects = useValue ? resolveConfigObjects(sourceFile, useValue) : [];
  if (useValue && useObjects.length === 0) limitations.push("`use` is not an object literal; trace/screenshot/video could not be read.");
  const use = readObject(useObjects);
  if (use.hasSpread) limitations.push("`use` uses spread syntax; trace/screenshot/video may come from the spread value.");

  const projectUses: ObjectReadResult[] = [];
  const projectsValue = top.properties.get("projects");
  if (projectsValue && ts.isArrayLiteralExpression(unwrap(projectsValue))) {
    for (const element of (unwrap(projectsValue) as ts.ArrayLiteralExpression).elements) {
      const project = readObject(resolveConfigObjects(sourceFile, element as ts.Expression));
      const projectUse = project.properties.get("use");
      if (projectUse) projectUses.push(readObject(resolveConfigObjects(sourceFile, projectUse)));
    }
  }

  for (const key of USE_SETTINGS) {
    const value = use.properties.get(key);
    if (value) {
      settings[key] = detail(sourceFile, value, "config");
      continue;
    }
    const projectValue = projectUses.map((projectUse) => projectUse.properties.get(key)).find(Boolean);
    settings[key] = projectValue ? detail(sourceFile, projectValue, "project") : { kind: "missing" };
  }

  const { names, determinable } = reporterNames(sourceFile, top.properties.get("reporter"));
  if (!determinable) limitations.push("The reporter list contains runtime expressions; only literal reporter names are listed.");
  const reporters: ReporterAnalysis = {
    detected: names,
    html: names.includes("html"),
    json: names.includes("json"),
    allure: names.some((name) => /allure-playwright/.test(name)),
    determinable,
  };
  return { found: true, settings, reporters, limitations };
}
