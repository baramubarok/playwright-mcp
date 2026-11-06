/**
 * Auto fixture shared by all scaffolded domains. It records real browser events and attaches them
 * as `mcp-diagnostics` when a test does not end with its expected status, so run_playwright_test and
 * get_failure_details can report console errors, page errors and failed requests per test.
 */
export const DIAGNOSTICS_FIXTURE_SOURCE = `
import { test as base, expect } from '@playwright/test';

const MAX_EVENTS = 20;
const MAX_TEXT = 500;

type ConsoleEntry = { type: string; text: string; location?: string };
type PageErrorEntry = { message: string; stack?: string };
type RequestEntry = { url: string; method: string; status?: number; failure?: string; resourceType: string };

export const test = base.extend<{ mcpDiagnostics: void }>({
  mcpDiagnostics: [
    async ({ page }, use, testInfo) => {
      const consoleMessages: ConsoleEntry[] = [];
      const pageErrors: PageErrorEntry[] = [];
      const failedRequests: RequestEntry[] = [];
      const push = <T>(list: T[], value: T) => {
        if (list.length < MAX_EVENTS) list.push(value);
      };

      page.on('console', (message) => {
        const type = message.type();
        if (type !== 'error' && type !== 'warning') return;
        const { url, lineNumber } = message.location();
        push(consoleMessages, { type, text: message.text().slice(0, MAX_TEXT), location: url ? \`\${url}:\${lineNumber}\` : undefined });
      });
      page.on('pageerror', (error) => {
        push(pageErrors, { message: error.message.slice(0, MAX_TEXT), stack: error.stack?.split('\\n').slice(0, 4).join('\\n') });
      });
      page.on('requestfailed', (request) => {
        push(failedRequests, { url: request.url(), method: request.method(), failure: request.failure()?.errorText, resourceType: request.resourceType() });
      });
      page.on('response', (response) => {
        if (response.status() < 400) return;
        const request = response.request();
        push(failedRequests, { url: response.url(), method: request.method(), status: response.status(), resourceType: request.resourceType() });
      });

      await use();

      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach('mcp-diagnostics', {
          body: JSON.stringify({ consoleMessages, pageErrors, failedRequests }),
          contentType: 'application/json',
        });
      }
    },
    { auto: true },
  ],
});

export { expect };
`;
