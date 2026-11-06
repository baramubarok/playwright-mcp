import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { findProjectRoot } from "../lib/config.js";
import { resolveProjectPath, validatePathWithinRoot } from "../lib/pathSecurity.js";
import { McpToolError } from "../lib/toolErrors.js";
import { parseGherkin } from "../lib/testCases/gherkin.js";
import { parseCsv, rowsToTestCases } from "../lib/testCases/tabular.js";
import type { ParseResult, TestCase } from "../lib/testCases/types.js";
import { readXlsxRows } from "../lib/testCases/xlsx.js";

export const TEST_CASE_DIR = "docs/test-case";
const MAX_FILES = 50;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_XLSX_BYTES = 2 * 1024 * 1024;
const MAX_DEPTH = 3;
const FORMATS = { ".feature": "gherkin", ".csv": "csv", ".xlsx": "xlsx" } as const;

export const readTestCasesInputShape = {
  path: z
    .string()
    .optional()
    .describe("Optional file or sub-folder inside docs/test-case/ (e.g. \"docs/test-case/login.feature\"). Default: the whole folder."),
  ids: z.array(z.string().max(64)).max(100).optional().describe("Only return these test case IDs (e.g. [\"TC-001\"])."),
  maxCases: z.number().int().min(1).max(500).optional().describe("Maximum number of test cases returned. Default: 200."),
  includeExamples: z.boolean().optional().describe("Also read files named example.* (the samples created by init_qa_project). Default: false."),
  projectRoot: z.string().optional().describe("Optional path to the target project root. Auto-detected if omitted."),
};

export const readTestCasesSchema = z.object(readTestCasesInputShape);
export type ReadTestCasesInput = z.infer<typeof readTestCasesSchema>;

export interface ReadTestCasesOutput {
  projectRoot: string;
  directory: string;
  files: Array<{ file: string; format: "gherkin" | "csv" | "xlsx"; caseCount: number }>;
  skippedFiles: Array<{ file: string; reason: string }>;
  testCases: TestCase[];
  /** Number of cases found before ids/maxCases limited the list. */
  totalCases: number;
  truncated: boolean;
  warnings: string[];
}

function formatOf(fileName: string): "gherkin" | "csv" | "xlsx" | undefined {
  return FORMATS[path.extname(fileName).toLowerCase() as keyof typeof FORMATS];
}

function collectFiles(directory: string, includeExamples: boolean, depth = 0, found: string[] = []): string[] {
  if (depth > MAX_DEPTH || found.length >= MAX_FILES) return found;
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (found.length >= MAX_FILES) break;
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const fullPath = path.join(directory, entry.name);
    // Dirent flags do not follow symlinks, so linked files and folders are never read.
    if (entry.isDirectory()) collectFiles(fullPath, includeExamples, depth + 1, found);
    else if (entry.isFile() && formatOf(entry.name) && (includeExamples || !/^example\./i.test(entry.name))) found.push(fullPath);
  }
  return found;
}

async function parseFile(filePath: string, relPath: string, root: string): Promise<{ format: "gherkin" | "csv" | "xlsx"; result: ParseResult }> {
  const format = formatOf(filePath)!;
  const size = statSync(filePath).size;
  const limit = format === "xlsx" ? MAX_XLSX_BYTES : MAX_TEXT_BYTES;
  if (size > limit) throw new McpToolError("INVALID_INPUT", `file is larger than ${limit / 1024 / 1024} MB.`);

  if (format === "xlsx") return { format, result: rowsToTestCases(await readXlsxRows(filePath, root), relPath) };
  const content = readFileSync(filePath, "utf-8");
  return { format, result: format === "gherkin" ? parseGherkin(content, relPath) : parseCsv(content, relPath) };
}

export async function readTestCases(input: ReadTestCasesInput): Promise<ReadTestCasesOutput> {
  const root = findProjectRoot(undefined, input.projectRoot);
  const directoryPath = path.join(root, TEST_CASE_DIR);
  if (!existsSync(directoryPath)) {
    throw new McpToolError("NOT_FOUND", `${TEST_CASE_DIR}/ was not found in ${root}. Run init_qa_project or create the folder and add test case files (.feature, .csv, .xlsx).`);
  }
  const testCaseRoot = resolveProjectPath(TEST_CASE_DIR, root, { expectedType: "directory" });

  // Only the test case folder is readable, even when a path elsewhere in the project is requested.
  const target = input.path ? validatePathWithinRoot(path.resolve(root, input.path), testCaseRoot, input.path) : testCaseRoot;
  if (!existsSync(target)) throw new McpToolError("NOT_FOUND", `Path "${input.path}" was not found in ${TEST_CASE_DIR}/.`);

  const includeExamples = input.includeExamples ?? false;
  const targetStat = statSync(target);
  const filePaths = targetStat.isDirectory() ? collectFiles(target, includeExamples) : [target];

  const warnings: string[] = [];
  const files: ReadTestCasesOutput["files"] = [];
  const skippedFiles: ReadTestCasesOutput["skippedFiles"] = [];
  const allCases: TestCase[] = [];

  for (const filePath of filePaths) {
    const relPath = path.relative(root, filePath).split(path.sep).join("/");
    if (!formatOf(filePath)) {
      skippedFiles.push({ file: relPath, reason: "unsupported format (use .feature, .csv or .xlsx)." });
      continue;
    }
    try {
      const { format, result } = await parseFile(filePath, relPath, root);
      files.push({ file: relPath, format, caseCount: result.cases.length });
      allCases.push(...result.cases);
      warnings.push(...result.warnings);
    } catch (error) {
      skippedFiles.push({ file: relPath, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  const seen = new Map<string, string>();
  for (const testCase of allCases) {
    const previous = seen.get(testCase.id);
    if (previous) warnings.push(`Duplicate test case ID ${testCase.id} in ${previous} and ${testCase.source.file}; IDs should be unique so generated tests stay traceable.`);
    else seen.set(testCase.id, testCase.source.file);
  }

  if (filePaths.length >= MAX_FILES) warnings.push(`Only the first ${MAX_FILES} files were read.`);
  if (files.length === 0 && skippedFiles.length === 0) {
    warnings.push(`No test case files found in ${TEST_CASE_DIR}/${includeExamples ? "" : " (example.* files are skipped; pass includeExamples to read them)"}.`);
  }

  const wanted = input.ids ? new Set(input.ids.map((id) => id.toLowerCase())) : undefined;
  const matching = wanted ? allCases.filter((testCase) => wanted.has(testCase.id.toLowerCase())) : allCases;
  if (wanted) {
    const found = new Set(matching.map((testCase) => testCase.id.toLowerCase()));
    for (const id of input.ids ?? []) if (!found.has(id.toLowerCase())) warnings.push(`Test case ${id} was not found.`);
  }
  const limit = input.maxCases ?? 200;

  return {
    projectRoot: root,
    directory: TEST_CASE_DIR,
    files,
    skippedFiles,
    testCases: matching.slice(0, limit),
    totalCases: matching.length,
    truncated: matching.length > limit,
    warnings,
  };
}
