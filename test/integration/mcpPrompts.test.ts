import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function call(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(projectRoot, "dist/index.js")], { cwd: projectRoot, stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timeout waiting for ${method}`));
    }, 10_000);
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      for (const line of buffer.split(/\r?\n/)) {
        try {
          const message = JSON.parse(line) as Record<string, unknown>;
          if (message.id === 2) {
            clearTimeout(timer);
            child.kill();
            resolve(message);
          }
        } catch {
          // wait for a complete line
        }
      }
    });
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "prompt-test", version: "1.0.0" } } };
    child.stdin.write(`${JSON.stringify(init)}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method, params })}\n`);
  });
}

const textOf = (response: Record<string, unknown>): string =>
  ((response.result as { messages: Array<{ content: { text: string } }> }).messages[0].content.text);

test("the server exposes the QA-first prompts", async () => {
  const response = await call("prompts/list", {});
  const prompts = (response.result as { prompts: Array<{ name: string; arguments?: Array<{ name: string; required?: boolean }> }> }).prompts;
  assert.deepEqual(prompts.map((prompt) => prompt.name).sort(), [
    "playwright_generate_from_testcase",
    "playwright_run_and_heal",
    "playwright_setup_qa_project",
    "playwright_write_test",
  ]);
  const generate = prompts.find((prompt) => prompt.name === "playwright_generate_from_testcase");
  assert.deepEqual(generate?.arguments?.map((argument) => [argument.name, Boolean(argument.required)]), [["ids", false]]);
});

test("generate prompt names the QA tools in order and honours the ids argument", async () => {
  const all = textOf(await call("prompts/get", { name: "playwright_generate_from_testcase", arguments: {} }));
  const sections = all.split(/\n\d\. (?=[A-Z]{4})/).slice(1);
  assert.equal(sections.length, 7);
  const expectedTools: Array<[number, string]> = [[0, "check_test_prerequisites"], [1, "read_test_cases"], [2, "inspect_page"], [3, "scaffold_test_domain"], [5, "score_test_quality"], [5, "run_playwright_test"]];
  for (const [index, tool] of expectedTools) assert.ok(sections[index].includes(tool), `${tool} should be in step ${index + 1}`);
  assert.match(all, /ask which ones to implement first/);

  const selected = textOf(await call("prompts/get", { name: "playwright_generate_from_testcase", arguments: { ids: "TC-001, TC-002" } }));
  assert.match(selected, /Implement ONLY these test cases: TC-001, TC-002/);
});

test("no prompt tells the AI to read frontend source code, and all keep the selector priority and one-handler rules", async () => {
  for (const name of ["playwright_write_test", "playwright_generate_from_testcase", "playwright_setup_qa_project", "playwright_run_and_heal"]) {
    const text = textOf(await call("prompts/get", { name, arguments: {} }));
    assert.doesNotMatch(text, /Read application routes and component source files/i, name);
    assert.doesNotMatch(text, /read (?:the )?(?:frontend|component|source) (?:code|files)(?! code)/i, name);
  }
  const write = textOf(await call("prompts/get", { name: "playwright_write_test", arguments: {} }));
  assert.match(write, /data-testid > data-qa > data-\{ID_SELECTOR\}/);
  assert.match(write, /inlineApiCall/);
  assert.match(write, /\[TC-001\]/);
  assert.match(write, /scaffold_auth_setup/);
  const setup = textOf(await call("prompts/get", { name: "playwright_setup_qa_project", arguments: {} }));
  assert.match(setup, /NEVER ask for passwords/);
  assert.match(setup, /init_qa_project/);
  const heal = textOf(await call("prompts/get", { name: "playwright_run_and_heal", arguments: {} }));
  assert.match(heal, /inspect_page/);
});
