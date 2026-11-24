import { defineConfig, devices } from '@playwright/test';

// End-to-end tests of the web client: the built client from `scripts/serve.mjs` (build it first: `bun run --cwd apps/web build`), the API of the
// Compose stack (`make up`). 127.0.0.1, not localhost: a CI runner may resolve localhost to ::1, where nothing listens.
// Run: `bunx playwright test -c apps/web/playwright.config.ts --project=chromium` (`E2E_WEB_PORT` changes the port; a server already on the port is an error, never reused). Install the browsers once:
// `bunx playwright install --with-deps chromium firefox webkit` (test-e2e/support/run-check.ts says whether they are there).
/**
 * The port of the client's server: 4173, or `E2E_WEB_PORT` (two checkouts can run their specs side by side). The API must allow the page's origin:
 * start the stack with the same `E2E_WEB_PORT` in its environment (compose.m6.yaml reads it), or the specs that call the API from the page are refused by its origin check.
 */
function webPort(): number {
  const asked = process.env['E2E_WEB_PORT'];
  if (asked === undefined) return 4173;
  const port = Number(asked);
  if (!/^\d+$/.test(asked) || port < 1 || port > 65535) throw new Error(`E2E_WEB_PORT must be a port number (1 to 65535), not "${asked}".`);
  return port;
}
const WEB_PORT = webPort();
export const E2E_API_URL = process.env['E2E_API_URL'] ?? 'http://127.0.0.1:8080';

/**
 * What Firefox, as Playwright ships it, cannot run: axe, and locators that go by a label or a name, on a screen of the client. Firefox crashes the page ("Page crashed") when the
 * ARIA tree of a page with an `aria-labelledby` region is read from two scripting worlds, and every screen is a section named by its title. Playwright issue 44135, Mozilla bug
 * 2090055 (fixed in Firefox 163). So Firefox leaves out the accessibility folder (except the two files that use no page of the client) and every `axe.spec`: they run in Chromium
 * and WebKit. `tools/ci/test/firefox-exclusion.test.mjs` fails once the Firefox of the installed Playwright is 163 or later, so that this cannot outlive the fix. Everything else runs.
 */
const FIREFOX_ARIA_CRASH_SPECS = [/\/test-e2e\/a11y\/(?!proof\.spec|support\.spec)/, /\/axe\.spec\.ts$/];

export default defineConfig({
  testDir: './test-e2e',
  testMatch: '**/*.spec.ts',
  outputDir: '../../test-results/playwright',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env['CI'] === undefined ? [['list']] : [['list'], ['html', { open: 'never', outputFolder: '../../test-results/playwright-report' }]],
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    headless: true,
    viewport: { width: 1280, height: 800 },
    // A trace records the development token that signInAs stores, and CI uploads test-results on failure: so CI keeps no traces. Locally a failing test keeps one.
    trace: process.env['CI'] === undefined ? 'retain-on-failure' : 'off',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'], viewport: { width: 1280, height: 800 } }, testIgnore: FIREFOX_ARIA_CRASH_SPECS },
    { name: 'webkit', use: { ...devices['Desktop Safari'], viewport: { width: 1280, height: 800 } } },
  ],
  webServer: {
    command: 'node scripts/serve.mjs',
    cwd: import.meta.dirname,
    url: `http://127.0.0.1:${WEB_PORT}/`,
    env: { PORT: String(WEB_PORT) },
    // Never a server this run did not start: one left on the port by another checkout would serve a different build, and the specs would test that one without a word.
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
