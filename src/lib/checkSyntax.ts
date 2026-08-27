import ts from "typescript";

/**
 * Syntax-only check (no type checker, no program) — catches malformed code
 * from a weaker LLM before it ever hits disk, without requiring the target
 * project's tsconfig. Works for .ts/.tsx/.js/.jsx/.mjs/.cjs via `fileName`'s
 * extension, which ts.transpileModule uses to pick the right grammar.
 */
export function checkSyntax(content: string, fileName: string): string[] {
  const { diagnostics } = ts.transpileModule(content, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.Latest,
    },
  });

  if (!diagnostics || diagnostics.length === 0) return [];

  return diagnostics.map((d) => {
    const message = ts.flattenDiagnosticMessageText(d.messageText, "\n");
    if (d.file && d.start !== undefined) {
      const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
      return `line ${line + 1}, col ${character + 1}: ${message}`;
    }
    return message;
  });
}
