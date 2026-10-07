import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ComprehensiveQualityScore } from "./scoreContent.js";
import { resolveProjectPath } from "./pathSecurity.js";

export interface HtmlReportOptions {
  score: ComprehensiveQualityScore;
  projectRoot: string;
  specPath?: string;
  suiteStatus?: "passed" | "failed" | "timedout" | "interrupted" | "flaky" | "skipped";
  durationMs?: number;
  totalTests?: number;
  passedTests?: number;
  failedTests?: number;
  videoPath?: string;
  traceZipPath?: string;
  outputPath?: string;
}

export function generateQualityHtmlReport(options: HtmlReportOptions): string {
  const {
    score,
    projectRoot,
    specPath,
    suiteStatus = "passed",
    durationMs = 0,
    totalTests = score.assertionDensity.testCount,
    passedTests = suiteStatus === "passed" ? totalTests : 0,
    failedTests = suiteStatus === "failed" ? 1 : 0,
    videoPath,
    traceZipPath,
  } = options;

  const targetDir = options.outputPath
    ? resolveProjectPath(path.dirname(options.outputPath), projectRoot, { forWrite: true })
    : resolveProjectPath("test-results", projectRoot, { forWrite: true });

  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  const reportFilePath = resolveProjectPath(
    options.outputPath ?? path.join(targetDir, "quality-report.html"),
    projectRoot,
    { forWrite: true },
  );

  const semanticPct = score.locatorQuality.semanticPct;
  const semanticColor =
    semanticPct >= 80 ? "#10b981" : semanticPct >= 50 ? "#f59e0b" : "#ef4444";
  const statusBadgeColor =
    suiteStatus === "passed"
      ? "#10b981"
      : suiteStatus === "failed"
        ? "#ef4444"
        : "#f59e0b";

  const fileRows = Object.entries(score.fileBreakdown ?? {
    [specPath ?? "spec"]: score,
  })
    .map(([file, fileScore]) => {
      const fSemantic = fileScore.locatorQuality.semanticPct;
      const fColor =
        fSemantic >= 80 ? "#10b981" : fSemantic >= 50 ? "#f59e0b" : "#ef4444";
      const warningsList =
        fileScore.warnings.length > 0
          ? `<ul class="warning-list">${fileScore.warnings
              .map((w) => `<li>${escapeHtml(w)}</li>`)
              .join("")}</ul>`
          : '<span class="badge-clean">Clean</span>';

      return `
      <tr>
        <td class="file-name"><code>${escapeHtml(file)}</code></td>
        <td>
          <div class="progress-bar-container">
            <div class="progress-bar" style="width: ${fSemantic}%; background-color: ${fColor};"></div>
          </div>
          <span style="font-weight: 600; color: ${fColor};">${fSemantic}%</span>
          <span class="muted">(${fileScore.locatorQuality.semanticCount}/${fileScore.locatorQuality.totalLocators})</span>
        </td>
        <td>${fileScore.assertionDensity.totalAssertions}</td>
        <td>${warningsList}</td>
      </tr>
    `;
    })
    .join("");

  const antiPatternCards = [
    { label: "Arbitrary Sleep (waitForTimeout)", count: score.antiPatterns.waitForTimeout },
    { label: "Manual Sleep (setTimeout)", count: score.antiPatterns.hardcodedSleep },
    { label: "Missing Await on Actions", count: score.antiPatterns.missingAwaitOnAction },
    { label: "Deep / Fragile CSS Chains", count: score.antiPatterns.deepLocatorChain },
    { label: "Un-scoped Index Locators", count: score.antiPatterns.indexBasedLocator },
    { label: "Manual Text Extraction", count: score.antiPatterns.manualTextExtraction },
  ]
    .map((ap) => {
      const isWarn = ap.count > 0;
      return `
      <div class="card ${isWarn ? "card-warn" : "card-ok"}">
        <div class="card-count">${ap.count}</div>
        <div class="card-label">${escapeHtml(ap.label)}</div>
      </div>
    `;
    })
    .join("");

  const artifactsSection = `
    <div class="artifacts-section">
      <h3>Artifacts & Media</h3>
      <div class="artifact-links">
        ${
          videoPath
            ? `<a class="btn-artifact" href="${escapeHtml(videoPath)}" target="_blank">📹 View Video Recording (.webm)</a>`
            : '<span class="muted-artifact">No video recording captured</span>'
        }
        ${
          traceZipPath
            ? `<a class="btn-artifact" href="${escapeHtml(traceZipPath)}" target="_blank">🔍 Open Trace Archive (.zip)</a>`
            : '<span class="muted-artifact">No trace archive captured</span>'
        }
      </div>
    </div>
  `;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Playwright Test Quality & Health Report</title>
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --border: #334155;
      --text: #f8fafc;
      --muted: #94a3b8;
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
      --primary: #3b82f6;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
      padding: 2rem;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 1.5rem;
      border-bottom: 1px solid var(--border);
      margin-bottom: 2rem;
    }
    .header-title h1 { font-size: 1.75rem; font-weight: 700; color: #fff; }
    .header-title p { color: var(--muted); font-size: 0.875rem; margin-top: 0.25rem; }
    .status-badge {
      display: inline-block;
      padding: 0.4rem 1rem;
      border-radius: 9999px;
      font-weight: 700;
      text-transform: uppercase;
      font-size: 0.875rem;
      letter-spacing: 0.05em;
    }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
    .metric-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 0.75rem;
      padding: 1.25rem;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }
    .metric-title { font-size: 0.875rem; color: var(--muted); font-weight: 500; }
    .metric-value { font-size: 2rem; font-weight: 800; margin: 0.5rem 0; }
    .metric-sub { font-size: 0.75rem; color: var(--muted); }

    .section-title { font-size: 1.25rem; font-weight: 600; margin-bottom: 1rem; }

    .anti-pattern-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 0.75rem; margin-bottom: 2rem; }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      padding: 1rem;
      text-align: center;
    }
    .card-ok { border-color: #1e3a2b; background: rgba(16, 185, 129, 0.05); }
    .card-warn { border-color: #7f1d1d; background: rgba(239, 68, 68, 0.1); }
    .card-count { font-size: 1.5rem; font-weight: 700; }
    .card-ok .card-count { color: var(--success); }
    .card-warn .card-count { color: var(--danger); }
    .card-label { font-size: 0.75rem; color: var(--muted); margin-top: 0.25rem; }

    table { width: 100%; border-collapse: collapse; background: var(--card-bg); border-radius: 0.75rem; overflow: hidden; border: 1px solid var(--border); margin-bottom: 2rem; }
    th, td { padding: 0.875rem 1rem; text-align: left; border-bottom: 1px solid var(--border); }
    th { background: #182234; color: var(--muted); font-size: 0.8rem; text-transform: uppercase; font-weight: 600; }
    tr:last-child td { border-bottom: none; }
    .file-name code { color: #60a5fa; background: #0f172a; padding: 0.2rem 0.4rem; border-radius: 0.25rem; font-size: 0.85rem; }
    .progress-bar-container { width: 100px; height: 8px; background: #334155; border-radius: 4px; display: inline-block; vertical-align: middle; margin-right: 0.5rem; overflow: hidden; }
    .progress-bar { height: 100%; border-radius: 4px; }
    .muted { color: var(--muted); font-size: 0.8rem; }
    .badge-clean { display: inline-block; background: rgba(16, 185, 129, 0.15); color: var(--success); padding: 0.2rem 0.6rem; border-radius: 0.25rem; font-size: 0.75rem; font-weight: 600; }
    .warning-list { font-size: 0.8rem; color: #fca5a5; list-style-position: inside; }
    .warning-list li { margin-bottom: 0.25rem; }

    .artifacts-section { background: var(--card-bg); border: 1px solid var(--border); border-radius: 0.75rem; padding: 1.25rem; margin-bottom: 2rem; }
    .artifacts-section h3 { font-size: 1rem; font-weight: 600; margin-bottom: 0.75rem; }
    .artifact-links { display: flex; gap: 1rem; flex-wrap: wrap; }
    .btn-artifact { display: inline-block; padding: 0.5rem 1rem; background: #2563eb; color: #fff; text-decoration: none; border-radius: 0.375rem; font-size: 0.875rem; font-weight: 500; transition: background 0.2s; }
    .btn-artifact:hover { background: #1d4ed8; }
    .muted-artifact { color: var(--muted); font-size: 0.875rem; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="header-title">
        <h1>Playwright Quality & Health Dashboard</h1>
        <p>Suite: <strong>${escapeHtml(specPath ?? "E2E Test Suite")}</strong> &bull; Duration: ${(durationMs / 1000).toFixed(2)}s &bull; Generated: ${new Date().toLocaleString()}</p>
      </div>
      <div>
        <span class="status-badge" style="background: ${statusBadgeColor}; color: #fff;">${escapeHtml(suiteStatus)}</span>
      </div>
    </div>

    <div class="grid">
      <div class="metric-card">
        <div class="metric-title">Semantic Locator Health</div>
        <div class="metric-value" style="color: ${semanticColor};">${semanticPct}%</div>
        <div class="metric-sub">${score.locatorQuality.semanticCount} semantic / ${score.locatorQuality.totalLocators} total locators</div>
      </div>
      <div class="metric-card">
        <div class="metric-title">Tests Outcome</div>
        <div class="metric-value">${passedTests} / ${totalTests}</div>
        <div class="metric-sub">${failedTests > 0 ? `<span style="color: var(--danger); font-weight:600;">${failedTests} failed</span>` : "All tests passed"}</div>
      </div>
      <div class="metric-card">
        <div class="metric-title">Assertion Density</div>
        <div class="metric-value">${score.assertionDensity.totalAssertions}</div>
        <div class="metric-sub">Avg ${score.assertionDensity.perTestAvg} assertions / test</div>
      </div>
      <div class="metric-card">
        <div class="metric-title">Anti-Patterns Detected</div>
        <div class="metric-value" style="color: ${Object.values(score.antiPatterns).reduce((a, b) => a + b, 0) > 0 ? "var(--warning)" : "var(--success)"};">
          ${Object.values(score.antiPatterns).reduce((a, b) => a + b, 0)}
        </div>
        <div class="metric-sub">Target: 0 anti-patterns</div>
      </div>
    </div>

    <h2 class="section-title">Anti-Pattern Scan</h2>
    <div class="anti-pattern-grid">
      ${antiPatternCards}
    </div>

    <h2 class="section-title">Domain Files Breakdown</h2>
    <table>
      <thead>
        <tr>
          <th>File</th>
          <th>Semantic Locators</th>
          <th>Assertions</th>
          <th>Quality Health & Warnings</th>
        </tr>
      </thead>
      <tbody>
        ${fileRows}
      </tbody>
    </table>

    ${artifactsSection}
  </div>
</body>
</html>`;

  writeFileSync(reportFilePath, html, "utf-8");
  return reportFilePath;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
