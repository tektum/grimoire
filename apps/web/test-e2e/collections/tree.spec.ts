import { expect, type Page, test } from '@playwright/test';
import { signInAs } from '../support/sign-in';
import { mockApi } from './mock-api';

// New page, rename, move and delete, as a person does them with the pointer: each shows in the tree, and the server's answer (here a stand-in that keeps the pages
// in memory and orders them as the API does) is what the tree ends on. Needs a development build of the client (`bunx vite build --mode e2e`).
const p = (id: string, parentId: string | null, position: string, title: string) => ({ id, urlId: id.padEnd(8, '0'), parentId, position, title, icon: null });
const names = (page: Page) => page.locator('[role="treeitem"] .tree-link').allInnerTexts();
const row = (page: Page, title: string) => page.getByRole('treeitem').filter({ has: page.getByRole('link', { name: title, exact: true }) });

test('new page, rename, move under another page, delete and restore', async ({ page, context }) => {
  await signInAs(context, 'e2e-alice', 'member', { check: false });
  const api = await mockApi(page, { collections: [{ id: 'c1', name: 'Dev', myPermission: 'read-write' }], pages: [p('a', null, 'p0000', 'Welcome'), p('b', 'a', 'p0000', 'Nested')] });
  await page.goto('/c/c1');
  await expect.poll(() => names(page)).toEqual(['Welcome', 'Nested']);

  await page.getByRole('button', { name: 'New page' }).click();
  await expect.poll(() => names(page)).toEqual(['Welcome', 'Nested', 'Untitled']);

  await page.getByRole('button', { name: 'Actions for Untitled' }).click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  await page.getByRole('textbox', { name: 'New title for Untitled' }).fill('Plan');
  await page.keyboard.press('Enter');
  await expect.poll(() => names(page)).toEqual(['Welcome', 'Nested', 'Plan']); // the new title, at the same index

  await page.getByRole('button', { name: 'Actions for Plan' }).click();
  await page.getByRole('menuitem', { name: 'Move to…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Welcome' }).click();
  await expect(row(page, 'Plan')).toHaveAttribute('aria-level', '2'); // under the other page
  await expect(row(page, 'Welcome')).toHaveAttribute('aria-expanded', 'true');

  await page.getByRole('button', { name: 'Actions for Plan' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
  await expect(row(page, 'Plan')).toHaveCount(0);

  // The trash lists it, and Restore puts it back at its old parent.
  await page.getByRole('link', { name: 'Trash' }).click();
  await expect(page.getByRole('listitem').filter({ hasText: 'Plan' })).toHaveCount(1);
  await page.getByRole('button', { name: 'Restore Plan' }).click();
  await expect(page.getByText('The trash is empty')).toBeVisible();
  await page.goto('/c/c1');
  await expect(row(page, 'Plan')).toHaveAttribute('aria-level', '2');
  await expect(row(page, 'Welcome')).toHaveAttribute('aria-expanded', 'true');
  expect(api.writes()).toEqual(['POST /v1/pages', expect.stringMatching(/^PATCH /), expect.stringMatching(/^POST \/v1\/pages\/.+\/move$/), expect.stringMatching(/^DELETE /), expect.stringMatching(/^POST \/v1\/trash\/.+\/restore$/)]);
});
