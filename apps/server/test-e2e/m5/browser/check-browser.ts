import { existsSync } from 'node:fs';
import { chromium } from '@playwright/test';

/** The one line printed, and the exit code 1 that follows, when the browser is not installed. */
export const MISSING_LINE = 'playwright chromium missing: run bunx playwright install chromium';

/** The browser to launch: `GRIMOIRE_E2E_CHROMIUM_PATH` when set (the test of this check forces a wrong one), else Playwright's. */
export const chromiumPath = (): string => process.env['GRIMOIRE_E2E_CHROMIUM_PATH'] ?? chromium.executablePath();

/** Ends the process with the exact line above when the browser binary is not there, instead of Playwright's long error. */
export function requireChromium(): void {
  if (!existsSync(chromiumPath())) {
    process.stderr.write(`${MISSING_LINE}\n`);
    process.exit(1);
  }
}
