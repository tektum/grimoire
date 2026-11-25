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
  { id: 'i1', path: 'handbook/welcome.md', status: 'ok' },
  { id: 'i2', path: 'handbook/guides/setup.md', status: 'ok' },
  { id: 'i3', path: 'handbook/archive/everything.md', status: 'skipped', message: 'too_large' },
  { id: 'i4', path: 'handbook/notes/broken.md', status: 'failed', message: 'invalid-markdown', hasSource: true },
];

test('the report of an import with one failed file', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'screenshots are taken once, in Chromium');
  await openShots(page, context, [p('a', null, 'p0000', 'Welcome')]);
  // The limit a reason names is the server's: the configuration it announces gets the 128 KB cap of a page's Markdown.
  await page.route('**/v1/config', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      json: {
        collabUrl: process.env['E2E_SHOT_COLLAB'] ?? 'ws://127.0.0.1:18081',
        fileStoreOrigin: null,
        local: true,
        minClientVersion: '0.0.0',
        providerBaseUrl: null,
        providerProjectId: null,
        maxMarkdownBytes: 131072,
      },
    }),
  );
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

const WITH_PICTURES: readonly ScriptedItem[] = [
  { id: 'i1', path: 'handbook/welcome.md', status: 'ok' },
  { id: 'i2', path: 'handbook/guides/setup.md', status: 'ok', remoteImageFailures: { blocked_address: 2, timeout: 1 } },
  { id: 'i3', path: 'handbook/notes/roadmap.md', status: 'ok', remoteImageFailures: { too_large: 1, type: 1, network: 3 } },
  { id: 'i4', path: 'handbook/notes/broken.md', status: 'failed', message: 'invalid-markdown', hasSource: true },
];

test('the report with the pictures from the web that were not copied', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'screenshots are taken once, in Chromium');
  await openShots(page, context, [p('a', null, 'p0000', 'Welcome')]);
  await scriptedImports(page, [{ status: 'done', total: 4, done: 3, failed: 1 }], { items: WITH_PICTURES });
  await page.goto('/import?import=imp1');
  const list = page.getByRole('list', { name: 'Files of the import' });
  await expect(list.getByRole('listitem')).toHaveCount(4);
  await expect(list).toContainText('Pictures from the web that were not copied: 2 were at an address this tool may not fetch from, 1 took too long to answer.');
  await expect(list).not.toContainText('blocked_address');
  await settledScreen(page);
  await shots(page, TASK, 'report-pictures');
});
