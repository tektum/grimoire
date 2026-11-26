import { expect, test, type Page } from '@playwright/test';
import { mockApi } from '../collections/mock-api';
import { signInAs } from '../support/sign-in';
import { chooseMarkdown, scriptedImports, smallZip, type ScriptedItem, type ScriptedState } from './support';

// A small zip is imported and its report has one row for each file; a second import is cancelled while running (R6.39 to R6.41, R11.3). Against the stand-in of the API and a scripted import (the routes
// are M7-T05's); written for the stack too, where the tree and the trash are asked as well. Needs a development build of the client (`bunx vite build --mode e2e`).
async function open(page: Page, context: Parameters<typeof signInAs>[0], states: readonly ScriptedState[], items: readonly ScriptedItem[] = []) {
  await signInAs(context, 'e2e-alice', 'member', { check: false });
  await mockApi(page, { collections: [{ id: 'c1', name: 'Dev', myPermission: 'read-write' }], pages: [], config: { maxMarkdownBytes: 131072 } });
  const sent = await scriptedImports(page, states, { items });
  await page.goto('/import');
  await expect(page.getByRole('heading', { level: 1, name: 'Import' })).toBeVisible();
  return sent;
}

const FILES: readonly ScriptedItem[] = [
  { id: 'i1', path: 'docs/welcome.md', status: 'ok' },
  { id: 'i2', path: 'docs/guide/setup.md', status: 'ok' },
  { id: 'i3', path: 'docs/big.md', status: 'skipped', message: 'too_large' },
  { id: 'i4', path: 'docs/<b>odd</b>.md', status: 'failed', message: 'invalid-markdown', hasSource: true },
];

test('a small zip imports, and the report has one row for each file, with the reasons as text', async ({ page, context }) => {
  const sent = await open(
    page,
    context,
    [
      { status: 'running', total: 4, done: 1 },
      { status: 'done', total: 4, done: 2, skipped: 1, failed: 1 },
    ],
    FILES,
  );
  await page.getByLabel('Choose a .zip file').setInputFiles(smallZip());
  await chooseMarkdown(page);
  await page.getByRole('button', { name: 'Import' }).click();
  await expect(page.getByRole('status').first()).toHaveText('Done: 2 pages imported, 1 skipped, 1 failed.');
  const rows = page.getByRole('list', { name: 'Files of the import' }).getByRole('listitem');
  await expect(rows).toHaveCount(FILES.length);
  await expect(rows.nth(2)).toContainText('The page is larger than the limit of 128 KB.'); // the sentence is the screen's, the number is the server's (GET /v1/config)
  await expect(rows.nth(2)).not.toContainText('too_large'); // the words, never the code
  await expect(rows.nth(3)).toContainText('docs/<b>odd</b>.md'); // text, not markup
  await expect(page.locator('.import-report-list b')).toHaveCount(0);
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100'); // done: every page was handled, the skipped and the failed too
  expect(sent.starts).toBe(1);
});

test('the original of a failed page is downloaded, and only a failed page that has one offers it', async ({ page, context }) => {
  const sent = await open(page, context, [{ status: 'done', total: 4, done: 2, skipped: 1, failed: 1 }], FILES);
  await page.goto('/import?import=imp1');
  await expect(page.getByRole('button', { name: /^Download source of/ })).toHaveCount(1);
  // The file store is asked for the file the API pointed at (WebKit gives a download of a stood-in answer no event, so the request is what is watched in all three).
  const fetched = page.waitForRequest((r) => r.url().includes('/__store/source/i4.md'));
  await page.getByRole('button', { name: 'Download source of docs/<b>odd</b>.md' }).click();
  await fetched;
  expect(sent.sources).toEqual(['i4']);
});

test('cancelling a second import while it runs shows that its pages were moved to the trash', async ({ page, context }) => {
  const sent = await open(page, context, [{ status: 'running', total: 10, done: 3 }], []);
  await page.goto('/import?import=imp2');
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '30');
  await page.getByRole('button', { name: 'Cancel import' }).click();
  await expect(page.getByRole('status').first()).toHaveText('Cancelled. The pages it created were moved to the trash.');
  await expect(page.getByRole('button', { name: 'Cancel import' })).toHaveCount(0);
  expect(sent.cancels).toBe(1);
});
