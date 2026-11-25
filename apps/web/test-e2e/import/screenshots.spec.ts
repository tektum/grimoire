import { expect, test } from '@playwright/test';
import { openShots, p, settledScreen } from '../page/shot-support';
import { shots } from '../support/shots';
import { scriptedImports, type ScriptedState } from './support';

// The import screen, light and dark, 1280 by 800 (test-results/shots/M6-T12a/): idle with the duplicate-run warning, and progress at 40 percent. Against the stand-in of the API and a scripted import (see
// `page/shot-support.ts` for the font and the person). Run by the same command as the other browser tests.
const TASK = 'M6-T12a';

test('the import screen idle, with the duplicate-run warning', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'screenshots are taken once, in Chromium');
  await openShots(page, context, [p('a', null, 'p0000', 'Welcome')]);
  await scriptedImports(page, []);
  await page.goto('/import');
  await expect(page.getByRole('note')).toBeVisible();
  await expect(page.getByLabel('Into the collection').getByRole('option')).toHaveText(['Dev']);
  await settledScreen(page);
  await shots(page, TASK, 'idle');
});

test('the import screen at 40 percent', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'screenshots are taken once, in Chromium');
  await openShots(page, context, [p('a', null, 'p0000', 'Welcome')]);
  const running: ScriptedState = { status: 'running', total: 25, done: 10 };
  await scriptedImports(page, [running]);
  await page.goto('/import?import=imp1');
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40');
  await settledScreen(page);
  await shots(page, TASK, 'progress');
});
