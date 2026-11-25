import { expect, test } from '@playwright/test';
import { openShots, p, settledScreen } from '../page/shot-support';
import { shots } from '../support/shots';
import { scriptedImports, type ScriptedItem, type ScriptedState } from './support';

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

const REPORT: readonly ScriptedItem[] = [
  { id: 'i1', path: 'handbook/welcome.md', status: 'imported' },
  { id: 'i2', path: 'handbook/guides/setup.md', status: 'imported' },
  { id: 'i3', path: 'handbook/archive/everything.md', status: 'skipped', message: 'too_large: the page is over the limit of 1 MB' },
  { id: 'i4', path: 'handbook/notes/broken.md', status: 'failed', message: 'The file could not be read as markdown.', hasSource: true },
];

test('the report of an import with one failed file', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'screenshots are taken once, in Chromium');
  await openShots(page, context, [p('a', null, 'p0000', 'Welcome')]);
  await scriptedImports(page, [{ status: 'done', total: 4, done: 2, skipped: 1, failed: 1 }], { items: REPORT });
  await page.goto('/import?import=imp1');
  await expect(page.getByRole('list', { name: 'Files of the import' }).getByRole('listitem')).toHaveCount(4);
  await settledScreen(page);
  await shots(page, TASK, 'report');
});

test('a cancelled import', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'screenshots are taken once, in Chromium');
  await openShots(page, context, [p('a', null, 'p0000', 'Welcome')]);
  await scriptedImports(page, [{ status: 'running', total: 25, done: 10 }]);
  await page.goto('/import?import=imp1');
  await page.getByRole('button', { name: 'Cancel import' }).click();
  await expect(page.getByRole('status').first()).toHaveText('Cancelled. The pages it created were moved to the trash.');
  await settledScreen(page);
  await shots(page, TASK, 'cancelled');
});
