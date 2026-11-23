import { BROWSERS, type BrowserName, requireBrowsers } from './browsers.ts';

// The check on its own (`bun run apps/web/test-e2e/support/run-check.ts [browser...]`), also run by the test that points the browsers path at nothing:
// exit 0 and no output when the browsers are there, 1 and the line when not.
const asked = process.argv.slice(2).filter((a): a is BrowserName => (BROWSERS as readonly string[]).includes(a));
requireBrowsers(asked.length > 0 ? asked : BROWSERS);
