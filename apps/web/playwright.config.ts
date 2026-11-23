import { defineConfig, devices } from '@playwright/test';

// End-to-end tests of the web client: the built client from `scripts/serve.mjs` (build it first: `bun run --cwd apps/web build`), the API of the
// Compose stack (`make up`). 127.0.0.1, not localhost: a CI runner may resolve localhost to ::1, where nothing listens.
// Run: `bunx playwright test -c apps/web/playwright.config.ts --project=chromium`. Install the browsers once:
// `bunx playwright install --with-deps chromium firefox webkit` (test-e2e/support/run-check.ts says whether they are there).
const WEB_PORT = 4173;
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
    reuseExistingServer: process.env['CI'] === undefined,
    timeout: 30_000,
  },
});
