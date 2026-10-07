import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function assertFileExists(filePath: string): Promise<void> {
  await access(filePath);
}

function requestServer(method: string, params: Record<string, unknown>, id: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(projectRoot, "dist/index.js")], {
      cwd: projectRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`MCP response timeout. stderr: ${stderr}`));
    }, 5_000);

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      for (const line of buffer.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const response = JSON.parse(line) as Record<string, unknown>;
          if (response.id === id) {
            clearTimeout(timeout);
            child.kill();
            resolve(response);
            return;
          }
        } catch {
          // Keep buffering until a complete newline-delimited JSON response arrives.
        }
      }
      buffer = buffer.slice(buffer.lastIndexOf("\n") + 1);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timeout);
        reject(new Error(`MCP server exited with ${code}. stderr: ${stderr}`));
      }
    });

    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

test("compiled MCP server completes initialize and exposes the tool catalog", async () => {
  await assertFileExists(path.join(projectRoot, "dist/index.js"));

  const initialize = await requestServer(
    "initialize",
    {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "sprint-0-test", version: "1.0.0" },
    },
    1,
  );
  assert.equal(initialize.jsonrpc, "2.0");
  assert.ok(initialize.result);

  const tools = await requestServer("tools/list", {}, 2);
  const toolNames = ((tools.result as { tools: Array<{ name: string }> }).tools ?? []).map((tool) => tool.name).sort();
  assert.deepEqual(toolNames, [
    "check_playwright_config",
    "check_test_prerequisites",
    "generate_test_report",
    "get_failure_details",
    "run_playwright_test",
    "scaffold_test_domain",
    "score_test_quality",
    "set_project_root",
  ]);
});

interface McpSession {
  request: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  notify: (method: string, params?: Record<string, unknown>) => void;
  close: () => Promise<number | null>;
}

function startSession(): McpSession {
  const child = spawn(process.execPath, [path.join(projectRoot, "dist/index.js")], { cwd: projectRoot, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map<number, (response: Record<string, unknown>) => void>();
  let buffer = "";
  let nextId = 1;
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        const response = JSON.parse(line) as Record<string, unknown>;
        pending.get(response.id as number)?.(response);
      }
      newline = buffer.indexOf("\n");
    }
  });
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  return {
    request: (method, params) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 10_000);
        pending.set(id, (response) => {
          clearTimeout(timer);
          resolve(response);
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      }),
    notify: (method, params = {}) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`),
    close: async () => {
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      const code = await exited;
      clearTimeout(timer);
      return code;
    },
  };
}

type ToolCallResult = { content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };

test("every tool declares an output schema and returns validated structured content or a typed error", async () => {
  const session = startSession();
  const root = await mkdtemp(path.join(tmpdir(), "mcp-contract-"));
  try {
    await session.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "contract-test", version: "1.0.0" } });
    session.notify("notifications/initialized");

    const listed = (await session.request("tools/list", {})).result as { tools: Array<{ name: string; outputSchema?: { type: string; properties: Record<string, unknown> } }> };
    for (const tool of listed.tools) {
      assert.equal(tool.outputSchema?.type, "object", `${tool.name} has an output schema`);
    }

    await writeFile(path.join(root, "playwright.config.ts"), "export default { retries: 1, use: { trace: 'on' } };\n");
    const config = (await session.request("tools/call", { name: "check_playwright_config", arguments: { projectRoot: root } })).result as ToolCallResult;
    assert.equal(config.isError, undefined);
    assert.equal(config.structuredContent?.analysis, "ast");
    // Text content mirrors the structured payload for clients that only forward text.
    const [summaryLine, json] = config.content[0].text.split("\n");
    assert.match(summaryLine, /playwright\.config\.ts: \d+ warning/);
    assert.deepEqual(JSON.parse(json), config.structuredContent);

    const denied = (await session.request("tools/call", {
      name: "get_failure_details",
      arguments: { reportPath: "/etc/passwd", testTitle: "x", projectRoot: root },
    })).result as ToolCallResult;
    assert.equal(denied.isError, true);
    assert.equal((denied.structuredContent?.error as { code: string }).code, "REPORT_ACCESS_DENIED");
    assert.match(denied.content[0].text, /^Error \[REPORT_ACCESS_DENIED\]/);

    const invalid = (await session.request("tools/call", {
      name: "scaffold_test_domain",
      arguments: { featureName: "../escape", projectRoot: root },
    })) as { result?: ToolCallResult; error?: { message: string } };
    // Input-schema violations are rejected before the handler runs.
    assert.match(invalid.result?.content[0].text ?? invalid.error?.message ?? "", /Invalid|validation/i);
  } finally {
    assert.equal(await session.close(), 0, "server exits cleanly when the client closes stdin");
    await rm(root, { recursive: true, force: true });
  }
});
