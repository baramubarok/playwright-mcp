import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getFailureDetails } from "../../src/tools/getFailureDetails.js";
import { registerReportPath } from "../../src/lib/reportRegistry.js";

const failedReport = JSON.stringify({
  suites: [{ title: "suite", specs: [{ title: "fails safely", tests: [{ status: "unexpected", results: [{ status: "failed", duration: 1, retry: 0, error: { message: "expected failure" } }] }] }] }],
});

test("reads only an explicitly authorized in-project report", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mcp-report-root-"));
  try {
    const reportPath = path.join(root, "test-results", "report.json");
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, failedReport);
    const detail = getFailureDetails({ reportPath: "test-results/report.json", projectRoot: root, testTitle: "fails safely" });
    assert.equal(detail.testTitle, "fails safely");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects arbitrary report files outside the project root", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mcp-report-root-"));
  const outside = await mkdtemp(path.join(tmpdir(), "mcp-report-outside-"));
  try {
    const reportPath = path.join(outside, "secret.json");
    await writeFile(reportPath, failedReport);
    assert.throws(
      () => getFailureDetails({ reportPath, projectRoot: root, testTitle: "fails safely" }),
      /outside the allowed project\/report boundaries/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("rejects an arbitrary file inside the project when it is outside report storage", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mcp-report-root-"));
  try {
    const secretPath = path.join(root, "package.json");
    await writeFile(secretPath, failedReport);
    assert.throws(
      () => getFailureDetails({ reportPath: "package.json", projectRoot: root, testTitle: "fails safely" }),
      /outside the allowed project\/report boundaries/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("permits a temporary report only after the runner registers it", async () => {
  const reportDir = await mkdtemp(path.join(tmpdir(), "pw-mcp-report-"));
  try {
    const reportPath = path.join(reportDir, "report.json");
    await writeFile(reportPath, failedReport);
    registerReportPath(reportPath);
    const detail = getFailureDetails({ reportPath, testTitle: "fails safely" });
    assert.equal(detail.errorMessage, "expected failure");
  } finally {
    await rm(reportDir, { recursive: true, force: true });
  }
});

test("requires stable testId when report titles are duplicated", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mcp-report-duplicate-"));
  try {
    const reportPath = path.join(root, "test-results", "report.json");
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(
      reportPath,
      JSON.stringify({
        suites: [{ title: "suite", file: "duplicate.spec.ts", specs: [
          { title: "same title", ok: false, line: 10, tests: [{ status: "unexpected", results: [{ status: "failed", duration: 1, retry: 0, error: { message: "first" } }] }] },
          { title: "same title", ok: false, line: 20, tests: [{ status: "unexpected", results: [{ status: "failed", duration: 1, retry: 0, error: { message: "second" } }] }] },
        ] }],
      }),
    );
    assert.throws(
      () => getFailureDetails({ reportPath: "test-results/report.json", projectRoot: root, testTitle: "same title" }),
      /Multiple tests titled/,
    );
    const detail = getFailureDetails({
      reportPath: "test-results/report.json",
      projectRoot: root,
      testTitle: "same title",
      testId: "duplicate.spec.ts:suite:20:0:same title:0",
    });
    assert.equal(detail.errorMessage, "second");
    assert.equal(detail.testId, "duplicate.spec.ts:suite:20:0:same title:0");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
