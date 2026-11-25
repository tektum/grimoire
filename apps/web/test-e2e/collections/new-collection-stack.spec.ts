import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { buildDevToken } from '../../test/support/dev-token';
import { waitForSynced } from '../support/sync';
import { apiUrl, devSecret } from '../support/env';
import { signInAs } from '../support/sign-in';

// An administrator makes a collection with the form and a page in it, against the real stack (the first thing the owner could not do). The workspace of the stack is shared by every specification, so it is
// never empty here: the empty workspace is `new-collection.spec.ts`, on the stand-in. Written for the stack (`make test-m6`, `make test-web-e2e`); not run where there is none.
test('an administrator makes a collection with the form, then a page in it, and a member sees the collection', async ({ page, context, browser, baseURL }) => {
  const name = `Handbook ${randomUUID().slice(0, 8)}`;
  await signInAs(context, 'e2e-admin', 'admin');
  await page.goto('/collections/new');
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Everyone in the workspace can edit').check();
  await page.getByRole('button', { name: 'Create collection' }).click();
  await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  const id = new URL(page.url()).pathname.split('/').pop() as string;

  await page.getByRole('button', { name: 'New page' }).click();
  await expect(page).toHaveURL(/\/p\/.+-[A-Za-z0-9]+$/);
  await waitForSynced(page);
  await expect(page.locator('.ProseMirror')).toBeVisible();

  // What was made is what the API holds: the collection, with the access that was chosen, and the page in it.
  const token = buildDevToken(devSecret(), 'e2e-admin', 'admin');
  const response = await fetch(`${apiUrl()}/v1/collections/${id}`, { headers: { Authorization: `Bearer ${token}` } });
  expect(await response.json()).toMatchObject({ id, name, defaultPermission: 'read_write' });

  // A member, who has no entry of their own, can open it (everyone may edit) and has no New collection.
  const other = await browser.newContext({ ...(baseURL === undefined ? {} : { baseURL }) });
  try {
    await signInAs(other, 'e2e-alice', 'member');
    const member = await other.newPage();
    await member.goto(`/c/${id}`);
    await expect(member.getByRole('heading', { level: 1, name })).toBeVisible();
    await expect(member.getByRole('link', { name: 'New collection' })).toHaveCount(0);
    await member.goto('/collections/new');
    await expect(member.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
  } finally {
    await other.close();
  }
});
