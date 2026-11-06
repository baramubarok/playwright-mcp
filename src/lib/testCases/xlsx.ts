import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { McpToolError } from "../toolErrors.js";

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const cell = value as { text?: unknown; richText?: Array<{ text?: string }>; result?: unknown; error?: unknown };
    if (Array.isArray(cell.richText)) return cell.richText.map((part) => part.text ?? "").join("").trim();
    if (cell.text !== undefined) return cellText(cell.text);
    if (cell.result !== undefined) return cellText(cell.result);
    if (cell.error !== undefined) return String(cell.error);
  }
  return "";
}

interface ExcelCell {
  value: unknown;
}
interface ExcelSheet {
  columnCount: number;
  eachRow(options: { includeEmpty: boolean }, callback: (row: { getCell(column: number): ExcelCell }) => void): void;
}
interface ExcelWorkbook {
  worksheets: ExcelSheet[];
  xlsx: { readFile(filePath: string): Promise<unknown> };
}

/**
 * Reads the first sheet of an .xlsx file as text rows. `exceljs` is optional and is resolved from the
 * QA project (not bundled), so the MCP stays light for teams that only use CSV or Gherkin.
 */
export async function readXlsxRows(filePath: string, projectRoot: string): Promise<string[][]> {
  let resolved: string;
  try {
    resolved = createRequire(path.join(projectRoot, "package.json")).resolve("exceljs");
  } catch {
    throw new McpToolError("NOT_FOUND", "The optional package 'exceljs' was not found in the project. Install it (npm install -D exceljs) to read .xlsx test cases, or export the sheet as CSV.");
  }

  const loaded = (await import(pathToFileURL(resolved).href)) as { default?: { Workbook: new () => ExcelWorkbook }; Workbook?: new () => ExcelWorkbook };
  const Workbook = loaded.default?.Workbook ?? loaded.Workbook;
  if (!Workbook) throw new McpToolError("INTERNAL_ERROR", "The installed 'exceljs' package does not expose a Workbook class.");

  const workbook = new Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.worksheets[0];
  if (!sheet) return [];

  const rows: string[][] = [];
  const width = sheet.columnCount;
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = [];
    for (let column = 1; column <= width; column++) cells.push(cellText(row.getCell(column).value));
    rows.push(cells);
  });
  return rows;
}
