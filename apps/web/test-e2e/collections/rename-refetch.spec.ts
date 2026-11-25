import { expect, test } from '@playwright/test';
import { signInAs } from '../support/sign-in';
import { mockApi } from './mock-api';

// The title field of a rename is still there, with the focus and what was typed, when the tree is read again while it is open. That read follows every change, and on a slow machine it is the
// answer to "New page" arriving after the person has opened the menu and chosen Rename (tree.spec.ts failed on a field that was detached by it). The read is held here until the field is open.
const p = (id: string, parentId: string | null, position: string, title: string) => ({ id, urlId: id.padEnd(8, '0'), parentId, position, title, icon: null });

test('a rename that is open keeps its field, its focus and its text when the tree is read again', async ({ page, context }) => {
  await signInAs(context, 'e2e-alice', 'member', { check: false });
  await mockApi(page, { collections: [{ id: 'c1', name: 'Dev', myPermission: 'read-write' }], pages: [p('a', null, 'p0000', 'Welcome')] });
  await page.goto('/c/c1');
  await expect(page.getByRole('link', { name: 'Welcome', exact: true })).toBeVisible();

  // Hold the read of the tree that follows the creation: registered last, so it is asked first, and hands the request on when released.
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  let reads = 0;
  await page.route('**/v1/collections/c1/tree', async (route) => {
    reads += 1;
    await held;
    await route.fallback();
  });

  await page.getByRole('button', { name: 'New page' }).click();
  await expect(page.getByRole('link', { name: 'Untitled', exact: true })).toBeVisible(); // shown from the answer of the creation, the read is still held
  await expect.poll(() => reads).toBeGreaterThanOrEqual(1);
  await page.getByRole('button', { name: 'Actions for Untitled' }).click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  const field = page.getByRole('textbox', { name: 'New title for Untitled' });
  await expect(field).toBeFocused();
  await field.pressSequentially('Pla');

  const readsBefore = reads;
  release(); // the tree is read again now, with the field open and a part of the title typed
  await expect.poll(() => reads).toBeGreaterThanOrEqual(readsBefore);
  await page.waitForLoadState('networkidle');
  await expect(field).toBeFocused();
  await expect(field).toHaveValue('Pla');
  await field.pressSequentially('n');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('link', { name: 'Plan', exact: true })).toBeVisible();
});
