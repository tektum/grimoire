import { expect, test } from '@playwright/test';
import { openShots, p, settledScreen } from '../page/shot-support';
import { shots } from '../support/shots';
import { CONSTRUCT_REPORT, scriptedImports, smallZip, type ScriptedItem, type ScriptedState } from './support';

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

test('the import screen with a file chosen and nothing said of what is in it, and with a part of an export in parts and Notion chosen', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'screenshots are taken once, in Chromium');
  await openShots(page, context, [p('a', null, 'p0000', 'Welcome')]);
  await scriptedImports(page, []);
  await page.goto('/import');
  await expect(page.getByLabel('Into the collection').getByRole('option')).toHaveText(['Dev']);
  await page.getByLabel('Choose a .zip file').setInputFiles(smallZip('Export-3f2a91c4-Part-1.zip'));
  await expect(page.getByText('Choose what is in the zip to start the import.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Import' })).toBeDisabled();
  await settledScreen(page);
  await shots(page, TASK, 'profile-unchosen');
  await page.getByRole('radio', { name: 'An export of Notion (Markdown and CSV files)' }).check();
  await expect(page.getByRole('button', { name: 'Import' })).toBeEnabled();
  await expect(page.getByRole('status')).toContainText('This looks like one part of an export split into parts.');
  await settledScreen(page);
  await shots(page, TASK, 'profile-notion-part');
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

// What the import did to the content (the construct report), light and dark (test-results/shots/M7-construct-report/): the table of the kinds, a list of pages opened, and a narrow view.
const CONSTRUCTS = 'M7-construct-report';
const CONSTRUCT_FILES: readonly ScriptedItem[] = [
  { id: 'i1', path: 'handbook/welcome.md', status: 'ok' },
  { id: 'i2', path: 'handbook/guides/setup.md', status: 'ok' },
];

test('the report of what happened to the content of an import of a Notion export', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'screenshots are taken once, in Chromium');
  await openShots(page, context, [p('a', null, 'p0000', 'Welcome')]);
  await scriptedImports(page, [{ status: 'done', total: 5, done: 5, report: CONSTRUCT_REPORT }], { items: CONSTRUCT_FILES });
  await page.goto('/import?import=imp1');
  await expect(page.getByRole('rowheader')).toHaveCount(9);
  await expect(page.getByRole('heading', { name: 'Pages that still hold HTML' })).toBeVisible();
  await settledScreen(page);
  await shots(page, CONSTRUCTS, 'constructs');
  await page.getByText('First 3 pages').first().click();
  await page.getByText('2 pages').nth(1).click();
  await expect(page.getByRole('link', { name: 'projects/Q3 plan.md' }).first()).toBeVisible();
  await settledScreen(page);
  await shots(page, CONSTRUCTS, 'constructs-open');
  await shots(page, CONSTRUCTS, 'constructs-narrow', { width: 360 });
});
