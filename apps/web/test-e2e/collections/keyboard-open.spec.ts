import { expect, test } from '@playwright/test';
import { signInAs } from '../support/sign-in';
import { mockApi } from './mock-api';

// A keyboard user reaches a page from the contents tree without a pointer: Tab into the tree, the arrow keys to a row, Enter. Needs a development build of the
// client (`bunx vite build --mode e2e`); the API is stood in for by `mockApi`.
const page0 = (id: string, parentId: string | null, position: string, title: string) => ({ id, urlId: id.padEnd(8, '0'), parentId, position, title, icon: null });

test('Tab into the tree, the arrow keys to a page, Enter opens it', async ({ page, context }) => {
  await signInAs(context, 'e2e-alice', 'member', { check: false });
  await mockApi(page, { collections: [{ id: 'c1', name: 'Dev', myPermission: 'read-write' }], pages: [page0('a', null, 'p1', 'Welcome'), page0('b', 'a', 'p1', 'Nested')] });
  await page.goto('/c/c1');
  await expect(page.getByRole('treeitem')).toHaveCount(2);
  for (let i = 0; i < 12 && !(await page.evaluate(() => document.activeElement?.getAttribute('role') === 'treeitem')); i += 1) await page.keyboard.press('Tab');
  await page.keyboard.press('ArrowDown'); // Welcome, then Nested
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/p\/nested-b0000000$/);
});
