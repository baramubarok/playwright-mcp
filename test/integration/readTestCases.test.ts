import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { initQaProject } from "../../src/tools/initQaProject.js";
import { readTestCases } from "../../src/tools/readTestCases.js";
import { checkTestPrerequisites } from "../../src/lib/prerequisites.js";

async function withProject<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "mcp-read-cases-"));
  try {
    initQaProject({ projectRoot: root, baseUrl: "https://app.example.com" });
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const LOGIN_FEATURE = "Feature: Login\n\n  @TC-001 @smoke\n  Scenario: Valid login\n    When I log in\n    Then I see the dashboard\n";
const CART_CSV = "ID,Title,Steps,Expected Result,Priority\nTC-201,Add to cart,Open product; Click Add,Item in cart,regression\nTC-202,Remove from cart,Open cart; Click Remove,Cart is empty,regression\n";

test("reads feature and csv files, skipping the init examples by default", async () => {
  await withProject(async (root) => {
    await writeFile(path.join(root, "docs/test-case/login.feature"), LOGIN_FEATURE);
    await mkdir(path.join(root, "docs/test-case/shop"));
    await writeFile(path.join(root, "docs/test-case/shop/cart.csv"), CART_CSV);
    await writeFile(path.join(root, "docs/test-case/notes.md"), "not a test case");

    const result = await readTestCases({ projectRoot: root });
    assert.equal(result.directory, "docs/test-case");
    assert.deepEqual(result.files, [
      { file: "docs/test-case/login.feature", format: "gherkin", caseCount: 1 },
      { file: "docs/test-case/shop/cart.csv", format: "csv", caseCount: 2 },
    ]);
    assert.deepEqual(result.testCases.map((testCase) => testCase.id), ["TC-001", "TC-201", "TC-202"]);
    assert.equal(result.totalCases, 3);
    assert.equal(result.truncated, false);
    assert.deepEqual(result.warnings, []);

    const withExamples = await readTestCases({ projectRoot: root, includeExamples: true });
    assert.ok(withExamples.files.some((file) => file.file === "docs/test-case/example.feature"));
    assert.ok(withExamples.totalCases > result.totalCases);
  });
});

test("filters by ids and path, limits with maxCases and reports unknown ids and duplicates", async () => {
  await withProject(async (root) => {
    await writeFile(path.join(root, "docs/test-case/login.feature"), LOGIN_FEATURE);
    await writeFile(path.join(root, "docs/test-case/cart.csv"), CART_CSV.replace("TC-202", "TC-001"));

    const byIds = await readTestCases({ projectRoot: root, ids: ["tc-201", "TC-999"] });
    assert.deepEqual(byIds.testCases.map((testCase) => testCase.id), ["TC-201"]);
    assert.ok(byIds.warnings.some((warning) => /Test case TC-999 was not found/.test(warning)));
    assert.ok(byIds.warnings.some((warning) => /Duplicate test case ID TC-001/.test(warning)));

    const single = await readTestCases({ projectRoot: root, path: "docs/test-case/cart.csv" });
    assert.deepEqual(single.files.map((file) => file.file), ["docs/test-case/cart.csv"]);

    const limited = await readTestCases({ projectRoot: root, maxCases: 1 });
    assert.equal(limited.testCases.length, 1);
    assert.equal(limited.totalCases, 3);
    assert.equal(limited.truncated, true);
  });
});

test("only reads inside docs/test-case and never follows symlinks", async () => {
  await withProject(async (root) => {
    await writeFile(path.join(root, "secret.feature"), LOGIN_FEATURE);
    await assert.rejects(readTestCases({ projectRoot: root, path: "secret.feature" }), /outside the project root/);
    await assert.rejects(readTestCases({ projectRoot: root, path: "docs/test-case/../../secret.feature" }), /outside the project root/);
    await assert.rejects(readTestCases({ projectRoot: root, path: "docs/test-case/missing.feature" }), /was not found/);

    const outside = await mkdtemp(path.join(tmpdir(), "mcp-read-cases-outside-"));
    try {
      await writeFile(path.join(outside, "leak.feature"), LOGIN_FEATURE);
      await symlink(outside, path.join(root, "docs/test-case/linked"));
      await symlink(path.join(outside, "leak.feature"), path.join(root, "docs/test-case/leak.feature"));
      const result = await readTestCases({ projectRoot: root, includeExamples: true });
      assert.ok(!result.files.some((file) => /leak|linked/.test(file.file)), JSON.stringify(result.files));
      await assert.rejects(readTestCases({ projectRoot: root, path: "docs/test-case/leak.feature" }), /outside the project root/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("a missing docs/test-case folder gives an actionable NOT_FOUND error", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mcp-read-cases-empty-"));
  try {
    await writeFile(path.join(root, "package.json"), "{}\n");
    await assert.rejects(readTestCases({ projectRoot: root }), /docs\/test-case\/ was not found.*init_qa_project/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an empty folder or only example files returns a hint instead of failing", async () => {
  await withProject(async (root) => {
    const result = await readTestCases({ projectRoot: root });
    assert.deepEqual(result.testCases, []);
    assert.match(result.warnings[0], /No test case files found.*example\.\* files are skipped/);
    assert.equal(checkTestPrerequisites(root).qa.testCaseDir.fileCount, 0);
  });
});

test("an .xlsx file without exceljs is skipped with install guidance; other files still load", async () => {
  await withProject(async (root) => {
    await writeFile(path.join(root, "docs/test-case/login.feature"), LOGIN_FEATURE);
    await writeFile(path.join(root, "docs/test-case/sheet.xlsx"), "PK-not-a-real-workbook");
    const result = await readTestCases({ projectRoot: root });
    assert.equal(result.totalCases, 1);
    assert.equal(result.skippedFiles.length, 1);
    assert.equal(result.skippedFiles[0].file, "docs/test-case/sheet.xlsx");
    assert.match(result.skippedFiles[0].reason, /npm install -D exceljs/);
  });
});

test("oversized and malformed files are skipped or reported without crashing the run", async () => {
  await withProject(async (root) => {
    await writeFile(path.join(root, "docs/test-case/big.csv"), "ID,Title,Steps\n" + "x".repeat(1024 * 1024 + 10));
    await writeFile(path.join(root, "docs/test-case/bad.csv"), "Only,Notes\n1,2\n");
    await writeFile(path.join(root, "docs/test-case/ok.feature"), LOGIN_FEATURE);
    const result = await readTestCases({ projectRoot: root });
    assert.equal(result.skippedFiles.find((file) => /big\.csv/.test(file.file))?.reason.includes("larger than"), true);
    assert.ok(result.warnings.some((warning) => /bad\.csv: missing required column/.test(warning)));
    assert.equal(result.totalCases, 1);
  });
});
