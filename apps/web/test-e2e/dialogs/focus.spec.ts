import { expect, test } from '@playwright/test';
import { mockApi } from '../collections/mock-api';
import { signInAs } from '../support/sign-in';

// What a menu item opens must get the focus, though the rest of the app is inert while the menu is open and is let go of just after it closes (`ui/inert-layers.ts`). Against the stand-in of the API.
// Needs a development build of the client (`bunx vite build --mode e2e`).
const p = (id: string, parentId: string | null, position: string, title: string) => ({ id, urlId: id.padEnd(8, '0'), parentId, position, title, icon: null });

test('Rename in the menu of a tree row puts the focus in the field, with the title selected', async ({ page, context }) => {
  await signInAs(context, 'e2e-alice', 'member', { check: false });
  await mockApi(page, { collections: [{ id: 'c1', name: 'Dev', myPermission: 'read-write' }], pages: [p('a', null, 'p0000', 'Welcome'), p('b', null, 'p0001', 'Notes')] });
  await page.goto('/c/c1');
  await expect(page.getByRole('treeitem')).toHaveCount(2);
  await page.getByRole('button', { name: 'Actions for Welcome' }).click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  const field = page.getByRole('textbox', { name: 'New title for Welcome' });
  await expect(field).toBeFocused();
  expect(await field.evaluate((el: HTMLInputElement) => el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0))).toBe('Welcome');
});

test('New page inside, from the menu of a row, opens the page with the title field focused', async ({ page, context }) => {
  await signInAs(context, 'e2e-alice', 'member', { check: false });
  await mockApi(page, { collections: [{ id: 'c1', name: 'Dev', myPermission: 'read-write' }], pages: [p('a', null, 'p0000', 'Welcome')] });
  await page.goto('/c/c1');
  await expect(page.getByRole('treeitem')).toHaveCount(1);
  await page.getByRole('button', { name: 'Actions for Welcome' }).click();
  await page.getByRole('menuitem', { name: 'New page inside' }).click();
  await expect(page.getByRole('textbox', { name: 'Page title' })).toBeFocused();
});
