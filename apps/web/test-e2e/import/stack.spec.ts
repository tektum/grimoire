import { expect, test, type Page } from '@playwright/test';
import { buildDevToken } from '../../test/support/dev-token';
import { makePage } from '../editor/pages';
import { apiUrl, devSecret } from '../support/env';
import { signInAs } from '../support/sign-in';
import { storedZip } from '../support/zip';
import { chooseMarkdown } from './support';

// The import screen against the stack: the real import routes (M7-T05), the real file store and the import job (M7-T04), signed in as development users. An accepted import is taken at once and runs
// to its end, so the specification below follows one to done (what the screen shows while it runs, the report, the source of a failed page and cancelling while it runs are in the scripted
// specifications of this folder: a run in the stack is too short to catch in the middle).
// Written for the stack (`make test-m6`, `make test-web-e2e`); not run where there is none.
/** What the browser did with the PUT of the zip to the file store: its status or why it failed, for the message of a failure ("could not be sent" alone does not say). */
function watchStore(page: Page): { readonly seen: string[] } {
  const seen: string[] = [];
  page.on('response', (response) => {
    if (response.request().method() === 'PUT') seen.push(`PUT ${new URL(response.url()).origin} -> ${String(response.status())}`);
  });
  // Where the API told the browser to PUT (the origin and path of the address, never its query: it is signed), and what the page's console said.
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (response.request().method() === 'POST' && url.pathname === '/v1/imports') {
      void response.json().then(
        (body: { upload?: { url?: string; method?: string; headers?: Record<string, string> } }) => {
          const target = body.upload?.url === undefined ? undefined : new URL(body.upload.url);
          seen.push(
            `create -> ${String(response.status())} upload ${body.upload?.method ?? '?'} ${target === undefined ? '?' : target.origin + target.pathname.replace(/[0-9a-f-]{36}/g, '<id>')} headers ${Object.keys(body.upload?.headers ?? {}).join(',')}`,
          );
        },
        () => seen.push('create -> not JSON'),
      );
    }
  });
  page.on('console', (message) => {
    if (message.type() === 'error') seen.push(`console: ${message.text().slice(0, 200)}`);
  });
  page.on('pageerror', (error) => seen.push(`pageerror: ${error.message.slice(0, 200)}`));
  page.on('requestfailed', (request) => seen.push(`${request.method()} ${new URL(request.url()).origin} failed: ${request.failure()?.errorText ?? '?'}`));
  return { seen };
}

/** Runs `check` and, when it fails, adds what `watchStore` saw to the message (a message given to `expect` is built before the wait, when nothing has happened yet). */
async function explained(store: { readonly seen: string[] }, check: () => Promise<void>): Promise<void> {
  try {
    await check();
  } catch (error) {
    // The store origin the application says it serves to the browser, to set beside the address it signed.
    const config = await fetch(`${apiUrl()}/v1/config`).then(
      async (r) => `config ${String(r.status)} fileStoreOrigin ${String(((await r.json().catch(() => ({}))) as { fileStoreOrigin?: unknown }).fileStoreOrigin)}`,
      () => 'config unreachable',
    );
    throw new Error(`${(error as Error).message}\nwhat the browser did with the zip: ${JSON.stringify(store.seen)}\n${config}`);
  }
}

const stateOf = async (id: string): Promise<{ status: string }> => {
  const response = await fetch(`${apiUrl()}/v1/imports/${id}`, { headers: { Authorization: `Bearer ${buildDevToken(devSecret(), 'e2e-alice', 'member')}` } });
  expect(response.status).toBe(200);
  return (await response.json()) as { status: string };
};

test('a zip is created, sent to the file store and started through the real routes: the import runs to done and the pages are in the collection', async ({ page, context }) => {
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
  await chooseMarkdown(page);
  const store = watchStore(page);
  await page.getByRole('button', { name: 'Import' }).click();
  await explained(store, () => expect(page).toHaveURL(/\/import\?import=[0-9a-f-]{36}/));
  const id = new URL(page.url()).searchParams.get('import') as string;
  await expect(page.getByRole('status').first()).toHaveText(/^Done: \d+ pages? imported/);
  expect((await stateOf(id)).status, 'the API holds it as done').toBe('done');
  await expect(page.getByRole('button', { name: 'Cancel import' })).toHaveCount(0);
});

test('a file that is not a zip is refused by the start with its own words, and the screen offers to try again', async ({ page, context }) => {
  const made = await makePage('# A collection to import into\n');
  await signInAs(context, 'e2e-alice', 'member');
  await page.goto('/import');
  await page.getByLabel('Into the collection').selectOption({ label: made.collectionName });
  await page.getByLabel('Choose a .zip file').setInputFiles({ name: 'notes.zip', mimeType: 'application/zip', buffer: Buffer.from('this is text, not an archive, and long enough to be a file') });
  await chooseMarkdown(page);
  const store = watchStore(page);
  await page.getByRole('button', { name: 'Import' }).click();
  await explained(store, () => expect(page.getByRole('alert')).toHaveText('That is not a zip file.'));
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
