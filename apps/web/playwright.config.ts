import { defineConfig, devices } from '@playwright/test';

// End-to-end tests of the web client: the built client from `scripts/serve.mjs` (build it first: `bun run --cwd apps/web build`), the API of the
// Compose stack (`make up`). 127.0.0.1, not localhost: a CI runner may resolve localhost to ::1, where nothing listens.
// Run: `bunx playwright test -c apps/web/playwright.config.ts --project=chromium` (`E2E_WEB_PORT` changes the port; a server already on the port is an error, never reused). Install the browsers once:
// `bunx playwright install --with-deps chromium firefox webkit` (test-e2e/support/run-check.ts says whether they are there).
/** The port of the client's server: 4173, or `E2E_WEB_PORT` (two checkouts can run their specs side by side). */
function webPort(): number {
  const asked = process.env['E2E_WEB_PORT'];
  if (asked === undefined) return 4173;
  const port = Number(asked);
  if (!/^\d+$/.test(asked) || port < 1 || port > 65535) throw new Error(`E2E_WEB_PORT must be a port number (1 to 65535), not "${asked}".`);
  return port;
}
const WEB_PORT = webPort();
export const E2E_API_URL = process.env['E2E_API_URL'] ?? 'http://127.0.0.1:8080';

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
    { name: 'firefox', use: { ...devices['Desktop Firefox'], viewport: { width: 1280, height: 800 } } },
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
