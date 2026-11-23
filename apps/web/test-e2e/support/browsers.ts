import { existsSync } from 'node:fs';
import { chromium, firefox, webkit } from '@playwright/test';

export const BROWSERS = ['chromium', 'firefox', 'webkit'] as const;
export type BrowserName = (typeof BROWSERS)[number];

/** The one line printed, and the exit code 1 that follows, when a browser is not installed. */
export const MISSING_LINE = 'playwright browsers missing: run bunx playwright install --with-deps chromium firefox webkit';

const launchers = { chromium, firefox, webkit } as const;

/** The browsers of `names` whose binary is not where Playwright looks (`PLAYWRIGHT_BROWSERS_PATH` moves that place). */
export function missingBrowsers(names: readonly BrowserName[] = BROWSERS, exists: (file: string) => boolean = existsSync): BrowserName[] {
  return names.filter((name) => !exists(launchers[name].executablePath()));
}

/** Ends the process with the exact line above when a browser binary is missing, instead of Playwright's long error. */
export function requireBrowsers(names: readonly BrowserName[] = BROWSERS): void {
  if (missingBrowsers(names).length > 0) {
    process.stderr.write(`${MISSING_LINE}\n`);
    process.exit(1);
  }
}
