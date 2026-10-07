import assert from "node:assert/strict";
import test from "node:test";
import { scoreContent } from "../../src/lib/scoreContent.js";

test("counts semantic locators and assertions in real source", () => {
  const score = scoreContent(`
    import { expect, test } from '@playwright/test';
    test('loads checkout', async ({ page }) => {
      await page.getByRole('button', { name: 'Submit' }).click();
      await expect(page.getByText('Success')).toBeVisible();
    });
  `);

  assert.equal(score.locatorQuality.semanticCount, 2);
  assert.equal(score.locatorQuality.cssXpathCount, 0);
  assert.equal(score.locatorQuality.semanticPct, 100);
  assert.equal(score.assertionDensity.totalAssertions, 1);
  assert.equal(score.assertionDensity.testCount, 1);
});

test("detects the configured anti-pattern categories", () => {
  const score = scoreContent(`
    test('fragile', async ({ page }) => {
      page.getByRole('button').nth(0).click();
      await page.waitForTimeout(100);
      setTimeout(() => undefined, 10);
      const text = await page.locator('div > span').innerText();
    });
  `);

  assert.equal(score.antiPatterns.waitForTimeout, 1);
  assert.equal(score.antiPatterns.hardcodedSleep, 1);
  assert.equal(score.antiPatterns.indexBasedLocator, 1);
  assert.equal(score.antiPatterns.manualTextExtraction, 1);
  assert.equal(score.antiPatterns.missingAwaitOnAction, 1);
  assert.equal(score.locatorQuality.cssXpathCount, 1);
});

test("ignores comments, strings and template text (Sprint 4 acceptance)", () => {
  const score = scoreContent(`
    // page.getByRole('button');
    // await expect(page.getByRole('alert')).toBeVisible();
    /* page.locator('div > span').click(); await page.waitForTimeout(100); */
    const example = "page.getByLabel('Email')";
    const template = \`page.locator('#id').textContent() \${"setTimeout("}\`;
    // test('commented out', async () => {});
  `);

  assert.equal(score.locatorQuality.semanticCount, 0);
  assert.equal(score.locatorQuality.cssXpathCount, 0);
  assert.equal(score.assertionDensity.totalAssertions, 0);
  assert.equal(score.assertionDensity.testCount, 0);
  assert.equal(score.antiPatterns.waitForTimeout, 0);
  assert.equal(score.antiPatterns.hardcodedSleep, 0);
  assert.equal(score.antiPatterns.manualTextExtraction, 0);
  assert.deepEqual(score.warnings, []);
});

test("handles multiline calls and only flags actions that are not awaited", () => {
  const score = scoreContent(`
    test.describe('multiline', () => {
      test('awaits correctly', async ({ page }) => {
        await test.step('submit', async () => {
          await page
            .getByRole('button', { name: 'Save' })
            .click();
          const pending = page.getByLabel('Name').fill('x');
          await Promise.all([page.getByText('a').click(), pending]);
          await page.evaluate(() => (document.querySelector('button') as HTMLElement).click());
          await expect.soft(page.getByText('Saved')).toBeVisible();
          await expect.poll(() => 1).toBe(1);
        });
      });
      test.skip('skipped with title', async () => {});
      test.fixme('fixme with title', async () => {});
      test.skip(({ browserName }) => browserName === 'webkit');
      test('floating action', async ({ page }) => {
        page.getByRole('link').click();
      });
    });
  `);

  assert.equal(score.assertionDensity.testCount, 4, "conditional test.skip(fn) is not a test");
  assert.equal(score.assertionDensity.totalAssertions, 2);
  assert.equal(score.antiPatterns.missingAwaitOnAction, 1);
  assert.match(score.warnings.find((warning) => /without "await"/.test(warning)) ?? "", /^line 19:/);
  assert.equal(score.antiPatterns.missingDescribeGrouping, 0);
  assert.equal(score.antiPatterns.missingTestStep, 0);
  assert.equal(score.scaffold.fixmeTests, 1);
  assert.equal(score.scaffold.skeleton, false);
});

test("distinguishes nested selectors, chained locators and skeleton markers", () => {
  const score = scoreContent(`
    // @mcp-skeleton
    // TODO: implement
    test.fixme('todo', async ({ page }) => {
      await page.locator('#root').locator('.card').click();
      await page.locator('div > span').click();
      await page.locator('//button').click();
      await page.getByRole('listitem').nth(2).click();
      await page.getByRole('listitem').first().click();
      const values = [1, 2].map((value) => value);
      values.slice().reverse();
    });
  `);

  assert.equal(score.locatorQuality.cssXpathCount, 4);
  assert.equal(score.antiPatterns.deepLocatorChain, 1);
  assert.equal(score.antiPatterns.indexBasedLocator, 2);
  assert.equal(score.warnings.filter((warning) => /deep\/nested CSS or XPath/.test(warning)).length, 2);
  assert.deepEqual(score.scaffold, { skeleton: true, todoCount: 1, fixmeTests: 1 });
  assert.match(score.warnings[0], /^Unimplemented scaffold skeleton/);
});
