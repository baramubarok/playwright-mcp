import { generatedId, isPriorityTag, type ParseResult, type TestCase } from "./types.js";

const MAX_ROWS = 500;

/** RFC 4180 reader: quoted cells, escaped quotes (""), and newlines inside quotes. */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const source = text.replace(/^\uFEFF/, "");

  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        cell += '"';
        index++;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"' && cell === "") {
      quoted = true;
    } else if (char === delimiter) {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[index + 1] === "\n") index++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** Picks the delimiter that splits the header row into the most columns. */
export function detectDelimiter(text: string): string {
  const firstLine = text.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0] ?? "";
  const counts = [",", ";", "\t"].map((delimiter) => ({ delimiter, count: firstLine.split(delimiter).length }));
  return counts.sort((left, right) => right.count - left.count)[0].delimiter;
}

type Column = "id" | "title" | "preconditions" | "steps" | "expected" | "priority" | "tags" | "feature";

const COLUMN_ALIASES: Record<Column, string[]> = {
  id: ["id", "no", "tcid", "testcaseid", "caseid", "testid", "number"],
  title: ["title", "name", "testcase", "testcasename", "scenario", "summary", "testcasetitle"],
  preconditions: ["preconditions", "precondition", "prerequisite", "prerequisites", "given"],
  steps: ["steps", "step", "teststeps", "action", "actions", "procedure"],
  expected: ["expectedresult", "expectedresults", "expected", "expectedoutcome", "result", "results"],
  priority: ["priority", "severity"],
  tags: ["tags", "tag", "type", "category", "labels"],
  feature: ["feature", "module", "area", "suite", "epic"],
};

function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Splits `a; b` or one step per line, and drops numbering/bullets such as `1.`, `2)` or `-`. */
export function splitList(value: string): string[] {
  return value
    .split(/\r?\n|;/)
    .map((item) => item.trim().replace(/^(?:\d+[.)]|[-*•])\s*/, "").trim())
    .filter((item) => item.length > 0);
}

/** Maps tabular rows (first row = header) to test cases. Used by CSV and XLSX. */
export function rowsToTestCases(rows: string[][], file: string): ParseResult {
  const warnings: string[] = [];
  const [header, ...dataRows] = rows;
  if (!header) return { cases: [], warnings: [`${file}: the file is empty.`] };

  const columns = new Map<Column, number>();
  header.forEach((name, index) => {
    const normalized = normalizeHeader(name);
    for (const [column, aliases] of Object.entries(COLUMN_ALIASES) as Array<[Column, string[]]>) {
      if (!columns.has(column) && aliases.includes(normalized)) columns.set(column, index);
    }
  });
  if (!columns.has("title") || !columns.has("steps")) {
    const missing = (["title", "steps"] as const).filter((column) => !columns.has(column));
    return { cases: [], warnings: [`${file}: missing required column(s): ${missing.join(", ")}. Found headers: ${header.join(" | ")}.`] };
  }

  const cell = (row: string[], column: Column): string => {
    const index = columns.get(column);
    return index === undefined ? "" : (row[index] ?? "").trim();
  };

  const cases: TestCase[] = [];
  let truncated = false;
  for (const [offset, row] of dataRows.entries()) {
    if (row.every((value) => value.trim() === "")) continue;
    if (cases.length >= MAX_ROWS) {
      truncated = true;
      break;
    }
    const rowNumber = offset + 2;
    const title = cell(row, "title");
    const steps = splitList(cell(row, "steps"));
    if (!title || steps.length === 0) {
      warnings.push(`${file} row ${rowNumber}: skipped because ${!title ? "Title" : "Steps"} is empty.`);
      continue;
    }
    const priority = cell(row, "priority");
    const tags = cell(row, "tags").split(/[,;\s]+/).map((tag) => tag.replace(/^@/, "")).filter(Boolean);
    const normalizedPriority = priority && isPriorityTag(priority) ? priority.toLowerCase() : priority || undefined;
    if (normalizedPriority && !tags.some((tag) => tag.toLowerCase() === normalizedPriority.toLowerCase())) tags.push(normalizedPriority);
    const feature = cell(row, "feature");
    cases.push({
      id: cell(row, "id") || generatedId(file, rowNumber - 1),
      title,
      ...(feature ? { feature } : {}),
      ...(normalizedPriority ? { priority: normalizedPriority } : {}),
      tags,
      preconditions: splitList(cell(row, "preconditions")),
      steps,
      expected: splitList(cell(row, "expected")),
      source: { file, row: rowNumber },
    });
    if (cases[cases.length - 1].expected.length === 0) warnings.push(`${file} row ${rowNumber}: "${title}" has no expected result.`);
  }
  if (truncated) warnings.push(`${file}: only the first ${MAX_ROWS} rows were read.`);
  return { cases, warnings };
}

export function parseCsv(content: string, file: string): ParseResult {
  return rowsToTestCases(parseDelimited(content, detectDelimiter(content)), file);
}
