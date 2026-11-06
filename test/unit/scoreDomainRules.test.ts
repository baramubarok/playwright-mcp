import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { scoreContent, scoreSpecAndRelatedPOMFiles } from "../../src/lib/scoreContent.js";

test("flags direct API calls and page.route in specs, but not in domain helper files", () => {
  const spec = `
    import { test, expect } from '../domain/orders/orders.fixture';
    test.describe('orders', () => {
      test('inline handlers @integration', async ({ page, request, context }) => {
        await test.step('arrange', async () => {
          await request.post('/api/orders', { data: {} });
          await page.request.get('/api/orders');
          await context.request.delete('/api/orders/1');
          const res = await fetch('https://x.test');
          await page.route('**/api/orders', (route) => route.fulfill({ status: 200 }));
          await context.route('**/x', (route) => route.abort());
        });
      });
    });
  `;
  const score = scoreContent(spec, "orders.spec.ts");
  assert.equal(score.antiPatterns.inlineApiCall, 4);
  assert.equal(score.antiPatterns.inlineRoute, 2);
  assert.ok(score.warnings.some((warning) => /domain \*\.api\.ts/.test(warning)));
  assert.ok(score.warnings.some((warning) => /domain \*\.mock\.ts/.test(warning)));

  const helper = scoreContent(spec, "orders.api.ts");
  assert.equal(helper.antiPatterns.inlineApiCall, 0);
  assert.equal(helper.antiPatterns.inlineRoute, 0);
});

test("does not flag fixture based API/mock calls or look-alike receivers", () => {
  const score = scoreContent(
    `
    test.describe('orders', () => {
      test('uses helpers @integration', async ({ page, ordersApi, ordersMock }) => {
        await test.step('go', async () => {
          await ordersMock.mockSuccess();
          const order = await ordersApi.create({ name: 'a' });
          await ordersApi.post(order);
          await page.getByRole('button').click();
          const map = new Map<string, string>();
          map.get('x');
        });
      });
    });
  `,
    "orders.spec.ts",
  );
  assert.equal(score.antiPatterns.inlineApiCall, 0);
  assert.equal(score.antiPatterns.inlineRoute, 0);
  assert.equal(score.antiPatterns.integrationWithoutApiHelper, 0);
});

test("ignores direct API calls that only appear in comments or strings", () => {
  const score = scoreContent(`
    // await request.post('/api');
    const text = "page.route('x')";
    test('t', async () => {});
  `, "x.spec.ts");
  assert.equal(score.antiPatterns.inlineApiCall, 0);
  assert.equal(score.antiPatterns.inlineRoute, 0);
});

test("flags @integration tests that do not use an *Api fixture", () => {
  const score = scoreContent(
    `
    test.describe('orders', () => {
      test('ui only @integration', async ({ page, ordersMock }) => { await test.step('x', async () => {}); });
      test('no fixtures @integration', async () => { await test.step('x', async () => {}); });
      test('with api @integration', async ({ ordersApi }) => { await test.step('x', async () => {}); });
      test('aliased api @integration', async ({ ordersApi: api }) => { await test.step('x', async () => {}); });
      test('ui test', async ({ page }) => { await test.step('x', async () => {}); });
      test('opaque fixtures @integration', async (fixtures) => { await test.step('x', async () => {}); });
    });
  `,
    "orders.spec.ts",
  );
  assert.equal(score.antiPatterns.integrationWithoutApiHelper, 2);
  assert.ok(score.warnings.some((warning) => /@integration but uses no \*Api fixture/.test(warning)));
});

test("reports domain helper methods that no other related file calls (implemented specs only)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "mcp-unused-helpers-"));
  try {
    const domain = path.join(root, "tests/e2e/domain/orders");
    await mkdir(domain, { recursive: true });
    await mkdir(path.join(root, "tests/e2e/specs"), { recursive: true });
    await writeFile(
      path.join(domain, "orders.api.ts"),
      `export class OrdersApi {
         async create() {}
         async getById() {}
         async remove() {}
         async cleanup() {}
         private async track() {}
       }\n`,
    );
    await writeFile(
      path.join(domain, "orders.mock.ts"),
      `export class OrdersMock { async mockSuccess() {} async mockEmpty() {} }\n`,
    );
    await writeFile(
      path.join(domain, "orders.fixture.ts"),
      `import { OrdersApi } from './orders.api';\nimport { OrdersMock } from './orders.mock';\n` +
        `export const run = async (api: OrdersApi) => { try { await api.create(); } finally { await api.cleanup(); } };\n` +
        `export const mocks = (m: OrdersMock) => m.mockSuccess();\n// m.mockEmpty()\n`,
    );
    const specPath = path.join(root, "tests/e2e/specs/orders.spec.ts");
    const specBody = (marker: string) =>
      `${marker}import { run, mocks } from '../domain/orders/orders.fixture';
import { OrdersApi } from '../domain/orders/orders.api';
test.describe('orders', () => {
  test('reads @integration', async ({ ordersApi }: { ordersApi: OrdersApi }) => {
    await test.step('assert', async () => { expect(await ordersApi.getById()).toBeUndefined(); });
  });
});\n`;

    await writeFile(specPath, specBody(""));
    const implemented = scoreSpecAndRelatedPOMFiles(specPath, root);
    assert.equal(implemented.antiPatterns.unusedDomainHelpers, 2);
    assert.ok(implemented.warnings.some((warning) => /orders\.api\.ts\] unused helper method\(s\): remove/.test(warning)));
    assert.ok(implemented.warnings.some((warning) => /orders\.mock\.ts\] unused helper method\(s\): mockEmpty/.test(warning)));

    await writeFile(specPath, specBody("// @mcp-skeleton\n"));
    assert.equal(scoreSpecAndRelatedPOMFiles(specPath, root).antiPatterns.unusedDomainHelpers, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
