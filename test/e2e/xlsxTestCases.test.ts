import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { initQaProject } from "../../src/tools/initQaProject.js";
import { readTestCases } from "../../src/tools/readTestCases.js";

/**
 * Opt-in: reads a real .xlsx written with exceljs. Uses the lab from realPlaywright.test.ts
 * (PW_MCP_REAL_PLAYWRIGHT_WORKSPACE) and needs exceljs in its node_modules; no browsers are required.
 */
const workspace = process.env.PW_MCP_REAL_PLAYWRIGHT_WORKSPACE;
const skip = workspace ? false : "set PW_MCP_REAL_PLAYWRIGHT_WORKSPACE (with exceljs installed) to read a real .xlsx";

test("read_test_cases reads an .xlsx workbook through the project's exceljs", { skip }, async () => {
  const ExcelJS = createRequire(path.join(workspace as string, "package.json"))("exceljs") as {
    Workbook: new () => { addWorksheet(name: string): { addRow(values: unknown[]): void }; xlsx: { writeFile(file: string): Promise<void> } };
  };
  const root = await mkdtemp(path.join(workspace as string, "xlsx-"));
  try {
    initQaProject({ projectRoot: root, baseUrl: "https://app.example.com" });
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Cases");
    sheet.addRow(["ID", "Title", "Preconditions", "Steps", "Expected Result", "Priority"]);
    sheet.addRow(["TC-301", "Search works", "", "1. Open home\n2. Type query; Press Enter", "Results listed", "smoke"]);
    sheet.addRow(["TC-302", { richText: [{ text: "Rich " }, { text: "title" }] }, "Logged in", "Open profile", { formula: "A1", result: "Profile shown" }, "regression"]);
    await workbook.xlsx.writeFile(path.join(root, "docs/test-case/search.xlsx"));

    const result = await readTestCases({ projectRoot: root });
    assert.deepEqual(result.skippedFiles, []);
    assert.deepEqual(result.testCases.map((testCase) => [testCase.id, testCase.title, testCase.steps.length, testCase.expected[0], testCase.priority]), [
      ["TC-301", "Search works", 3, "Results listed", "smoke"],
      ["TC-302", "Rich title", 1, "Profile shown", "regression"],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
