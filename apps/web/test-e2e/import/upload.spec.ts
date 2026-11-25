import { expect, test, type Page } from '@playwright/test';
import { mockApi } from '../collections/mock-api';
import { signInAs } from '../support/sign-in';
import { scriptedImports, smallZip, type ScriptedState } from './support';

// Choosing a zip, uploading it and watching the import (R6.39 to R6.41), in a browser. Against the stand-in of the API and a scripted import (the routes are M7-T05's; the same specification points at the
// stack when they are there). Needs a development build of the client (`bunx vite build --mode e2e`).
async function open(page: Page, context: Parameters<typeof signInAs>[0], states: readonly ScriptedState[], options = {}) {
  await signInAs(context, 'e2e-alice', 'member', { check: false });
  await mockApi(page, {
    collections: [
      { id: 'c1', name: 'Dev', myPermission: 'read-write' },
      { id: 'c2', name: 'Handbook', myPermission: 'read-only' },
    ],
    pages: [],
  });
  const sent = await scriptedImports(page, states, options);
  await page.goto('/import');
  await expect(page.getByRole('heading', { level: 1, name: 'Import' })).toBeVisible();
  return sent;
}

test('the screen shows the duplicate warning before the first upload, and only the collections that can be written', async ({ page, context }) => {
  const sent = await open(page, context, [{ status: 'running', total: 10, done: 0 }]);
  await expect(page.getByRole('note')).toHaveText('Running this import again creates a second copy of every page.');
  await expect(page.getByLabel('Into the collection').getByRole('option')).toHaveText(['Dev']);
  await expect(page.getByRole('button', { name: 'Import' })).toBeDisabled();
  expect(sent.creates).toEqual([]); // nothing was asked of the import routes before the person chose
});

test('a small zip is created, PUT with the headers the API gave, started, and its progress is watched to the end', async ({ page, context }) => {
  const sent = await open(page, context, [
    { status: 'running', total: 10, done: 0 },
    { status: 'running', total: 10, done: 4 },
    { status: 'done', total: 10, done: 10, skipped: 1 },
  ]);
  await page.getByLabel('Zip file').setInputFiles(smallZip());
  await page.getByRole('button', { name: 'Import' }).click();
  await expect(page).toHaveURL(/\/import\?import=imp1$/);
  expect(sent.creates).toEqual([{ collectionId: 'c1', fileName: 'export.zip', size: smallZip().buffer.length }]);
  expect(sent.puts).toHaveLength(1);
  expect(sent.puts[0]!.headers['content-type']).toBe('application/zip');
  // The size of what was sent is checked where the engine shows it to the route (WebKit shows neither the body of a file nor its length).
  if (sent.puts[0]!.bytes > 0) expect(sent.puts[0]!.bytes).toBe(smallZip().buffer.length);
  expect(sent.starts).toBe(1);
  await expect(page.getByRole('progressbar', { name: 'Import progress' })).toHaveAttribute('aria-valuenow', '40', { timeout: 15_000 });
  await expect(page.getByRole('status')).toHaveText('Done: 10 pages imported, 1 skipped.', { timeout: 15_000 });
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
  await expect(page.getByRole('button', { name: 'Import another file' })).toBeVisible();
});

test('a reload goes on watching the import (it is in the address)', async ({ page, context }) => {
  await open(page, context, [{ status: 'running', total: 20, done: 5 }]);
  await page.goto('/import?import=imp1');
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25');
  await page.reload();
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25');
});

test('a zip over the limit is refused with a message, and the screen is ready for another file', async ({ page, context }) => {
  await open(page, context, [], { createStatus: 413 });
  await page.getByLabel('Zip file').setInputFiles(smallZip());
  await page.getByRole('button', { name: 'Import' }).click();
  await expect(page.getByRole('alert')).toHaveText('That file is larger than an import may be.');
  await expect(page.getByRole('button', { name: 'Import' })).toBeEnabled();
});

test('a file that is not a zip is refused when the import starts', async ({ page, context }) => {
  await open(page, context, [], { startStatus: 422, startCode: 'not_a_zip' });
  await page.getByLabel('Zip file').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not a zip') });
  await page.getByRole('button', { name: 'Import' }).click();
  await expect(page.getByRole('alert')).toHaveText('That is not a zip file.');
});
