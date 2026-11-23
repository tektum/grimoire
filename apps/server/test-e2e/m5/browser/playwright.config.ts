import { defineConfig } from '@playwright/test';

// Real-browser check of the file store: CORS, signed uploads and downloads against the Compose store
// (`make db-up`, then `grimoire files-setup`). It runs on the host: the distroless image has no browser.
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  globalSetup: './global-setup.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: [['list']],
  use: { browserName: 'chromium', headless: true },
});
