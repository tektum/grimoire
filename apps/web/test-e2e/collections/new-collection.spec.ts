import { expect, test } from '@playwright/test';
import { signInAs } from '../support/sign-in';
import { shots } from '../support/shots';
import { mockApi } from './mock-api';

// An administrator makes the first collection from an empty workspace and then the first page in it; anyone else is told whom to ask. Against the stand-in of the API (the real stack has its own specification:
// `new-collection-stack.spec.ts`).
const PHONE = 390;

test('from an empty workspace an administrator makes a collection and a page in it', async ({ page, context }) => {
  await signInAs(context, 'e2e-ada', 'admin', { check: false });
  const api = await mockApi(page, { collections: [], pages: [], role: 'admin' });
  await page.goto('/');
  await expect(page.getByText('No collections yet')).toBeVisible();
  await page.getByRole('link', { name: 'New collection' }).click();
  await expect(page).toHaveURL(/\/collections\/new$/);
  await expect(page.getByLabel('Name')).toBeFocused();
  await page.getByLabel('Name').fill('Team handbook');
  await page.getByLabel('Everyone in the workspace can read').check();
  await page.getByRole('button', { name: 'Create collection' }).click();
  await expect(page).toHaveURL(/\/c\/new-c1$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Team handbook' })).toBeVisible();
  expect(api.collectionBodies()).toEqual([{ name: 'Team handbook', defaultPermission: 'read' }]);
  await page.getByRole('button', { name: 'New page' }).click();
  await expect(page).toHaveURL(/\/p\//);
});

test('the collections screen has New collection for an administrator beside the list, and the palette has it as a command', async ({ page, context }) => {
  await signInAs(context, 'e2e-ada', 'admin', { check: false });
  await mockApi(page, { collections: [{ id: 'c1', name: 'Dev', myPermission: 'read-write' }], pages: [], role: 'admin' });
  await page.goto('/c/c1');
  await expect(page.getByRole('navigation', { name: 'Collections' }).getByRole('link', { name: 'New collection' })).toBeVisible();
  await page.keyboard.press('Control+k');
  await page.getByRole('option', { name: 'New collection' }).click();
  await expect(page).toHaveURL(/\/collections\/new$/);
});

for (const role of ['member', 'viewer'] as const) {
  test(`a ${role} is told to ask an admin, has no New collection anywhere, and /collections/new is not found`, async ({ page, context }) => {
    await signInAs(context, 'e2e-bob', role, { check: false });
    const api = await mockApi(page, { collections: [], pages: [], role });
    await page.goto('/');
    await expect(page.getByText('No collections yet')).toBeVisible();
    await expect(page.getByText('Ask an admin to create one.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'New collection' })).toHaveCount(0);
    await page.goto('/collections/new');
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
    expect(api.writes()).toEqual([]);
  });
}

test('a refusal is said in plain words and the form stays', async ({ page, context }) => {
  await signInAs(context, 'e2e-ada', 'admin', { check: false });
  await mockApi(page, { collections: [], pages: [], role: 'admin', refuseCollection: { status: 409, code: 'name_taken' } });
  await page.goto('/collections/new');
  await page.getByLabel('Name').fill('Handbook');
  await page.getByRole('button', { name: 'Create collection' }).click();
  await expect(page.getByRole('alert')).toHaveText('A collection with that name already exists.');
  await expect(page.getByLabel('Name')).toHaveValue('Handbook');
});

test('pictures: the empty workspace and the form, light and dark, on a desktop and on a phone', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'screenshots are taken once, in Chromium');
  await signInAs(context, 'e2e-ada', 'admin', { check: false });
  await mockApi(page, { collections: [], pages: [], role: 'admin' });
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'New collection' })).toBeVisible();
  await shots(page, 'new-collection', 'empty-desktop');
  await shots(page, 'new-collection', 'empty-phone', { width: PHONE });
  await page.getByRole('link', { name: 'New collection' }).click();
  await page.getByLabel('Name').fill('Team handbook');
  await expect(page.getByLabel('Name')).toBeFocused();
  await shots(page, 'new-collection', 'form-desktop');
  await shots(page, 'new-collection', 'form-phone', { width: PHONE });
});
