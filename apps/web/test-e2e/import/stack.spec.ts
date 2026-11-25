import { expect, test, type Page } from '@playwright/test';
import { buildDevToken } from '../../test/support/dev-token';
import { makePage } from '../editor/pages';
import { apiUrl, devSecret } from '../support/env';
import { signInAs } from '../support/sign-in';
import { storedZip } from '../support/zip';

// The import screen against the stack: the real import routes (M7-T05) and the real file store, signed in as development users. The engine that runs an accepted import (M7-T04) is not in the stack yet,
// so an import is accepted and WAITS (`uploaded`); what an import does once it runs (the progress to done, the report, the source of a failed page, cancelling while it runs) is in the scripted
// specifications of this folder until then (`stack-engine.spec.ts` is its place). When the engine is in, an accepted import is taken at once and the waiting specification below must change with it.
// Written for the stack (`make test-m6`, `make test-web-e2e`); not run where there is none.
/** What the browser did with the PUT of the zip to the file store: its status or why it failed, for the message of a failure ("could not be sent" alone does not say). */
function watchStore(page: Page): { readonly seen: string[] } {
  const seen: string[] = [];
  page.on('response', (response) => {
    if (response.request().method() === 'PUT') seen.push(`PUT ${new URL(response.url()).origin} -> ${String(response.status())}`);
  });
  page.on('requestfailed', (request) => seen.push(`${request.method()} ${new URL(request.url()).origin} failed: ${request.failure()?.errorText ?? '?'}`));
  return { seen };
}

const stateOf = async (id: string): Promise<{ status: string }> => {
  const response = await fetch(`${apiUrl()}/v1/imports/${id}`, { headers: { Authorization: `Bearer ${buildDevToken(devSecret(), 'e2e-alice', 'member')}` } });
  expect(response.status).toBe(200);
  return (await response.json()) as { status: string };
};

test('a zip is created, sent to the file store and started through the real routes: the import is accepted and waits, and can be cancelled while it waits', async ({ page, context }) => {
  const made = await makePage('# A collection to import into\n');
  await signInAs(context, 'e2e-alice', 'member');
  await page.goto('/import');
  await expect(page.getByRole('heading', { level: 1, name: 'Import' })).toBeVisible();
  await page.getByLabel('Into the collection').selectOption({ label: made.collectionName });
  await page.getByLabel('Choose a .zip file').setInputFiles({
    name: 'export.zip',
    mimeType: 'application/zip',
    buffer: storedZip([
      { name: 'docs/welcome.md', text: '# Welcome\n\nA page of the export.\n' },
      { name: 'docs/guide.md', text: '# Guide\n\nAnother one.\n' },
    ]),
  });
  const store = watchStore(page);
  await page.getByRole('button', { name: 'Import' }).click();
  await expect(page, `the zip was sent: ${JSON.stringify(store.seen)}`).toHaveURL(/\/import\?import=[0-9a-f-]{36}/);
  const id = new URL(page.url()).searchParams.get('import') as string;
  await expect(page.getByRole('progressbar')).toBeVisible();
  await expect(page.getByRole('status').first()).toHaveText('Waiting to start…');
  expect((await stateOf(id)).status, 'the API holds it as accepted and waiting').toBe('uploaded');

  await page.getByRole('button', { name: 'Cancel import' }).click();
  await expect(page.getByRole('status').first()).toHaveText('Cancelled. The pages it created were moved to the trash.');
  expect((await stateOf(id)).status).toBe('cancelled');
  await expect(page.getByRole('button', { name: 'Cancel import' })).toHaveCount(0);
});

test('a file that is not a zip is refused by the start with its own words, and the screen offers to try again', async ({ page, context }) => {
  const made = await makePage('# A collection to import into\n');
  await signInAs(context, 'e2e-alice', 'member');
  await page.goto('/import');
  await page.getByLabel('Into the collection').selectOption({ label: made.collectionName });
  await page.getByLabel('Choose a .zip file').setInputFiles({ name: 'notes.zip', mimeType: 'application/zip', buffer: Buffer.from('this is text, not an archive, and long enough to be a file') });
  const store = watchStore(page);
  await page.getByRole('button', { name: 'Import' }).click();
  await expect(page.getByRole('alert'), `the zip was sent: ${JSON.stringify(store.seen)}`).toHaveText('That is not a zip file.');
  await expect(page.getByRole('button', { name: 'Import' })).toBeEnabled();
});

test('a viewer gets the not-found screen from the stack, and a member who cannot write in a collection is not offered it', async ({ page, context, browser, baseURL }) => {
  const readOnly = await makePage('# Read only\n', { permission: 'read' });
  const writable = await makePage('# Writable\n');
  await signInAs(context, 'e2e-vera', 'viewer');
  await page.goto('/import');
  await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
  const other = await browser.newContext({ ...(baseURL === undefined ? {} : { baseURL }) });
  try {
    await signInAs(other, 'e2e-alice', 'member');
    const member = await other.newPage();
    await member.goto('/import');
    await expect(member.getByLabel('Into the collection')).toBeVisible();
    // The options arrive after the screen: wait for one the person can write in first, so that the absence below is of a list that has loaded.
    await expect(member.getByLabel('Into the collection').getByRole('option', { name: writable.collectionName })).toHaveCount(1);
    await expect(member.getByLabel('Into the collection').getByRole('option', { name: readOnly.collectionName })).toHaveCount(0);
  } finally {
    await other.close();
  }
});
