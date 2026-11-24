import { expect, test } from '@playwright/test';
import { signInAs } from '../support/sign-in';
import { API, mockApi } from './mock-api';

process.env['E2E_DEV_TOKEN_SECRET'] ??= 'collections-specs-secret-0001';

// A 409 `would_create_cycle` shows its words and the tree is read again (route interception: the server answers the move with the conflict).
const p = (id: string, parentId: string | null, position: string, title: string) => ({ id, urlId: id.padEnd(8, '0'), parentId, position, title, icon: null });

test('a refused move says why in words and reads the tree again', async ({ page, context }) => {
  await signInAs(context, 'e2e-alice', 'member', { check: false });
  const api = await mockApi(page, { collections: [{ id: 'c1', name: 'Dev', myPermission: 'read-write' }], pages: [p('a', null, 'p0000', 'Alpha'), p('b', null, 'p0001', 'Beta')] });
  await page.route(`${API}/v1/pages/*/move`, (route) =>
    route.fulfill({
      status: 409,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': route.request().headers()['origin'] ?? '*' },
      body: JSON.stringify({ error: { code: 'would_create_cycle', message: 'cycle' } }),
    }),
  );
  await page.goto('/c/c1');
  await expect(page.getByRole('treeitem')).toHaveCount(2);
  const before = api.treeReads('c1');
  await page.getByRole('button', { name: 'Actions for Beta' }).click();
  await page.getByRole('menuitem', { name: 'Move to…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Alpha' }).click();
  await expect(page.getByText("A page can't be moved into itself or its own sub-pages")).toBeVisible();
  await expect.poll(() => api.treeReads('c1')).toBeGreaterThan(before);
});
