import { expect, test } from '@playwright/test';
import { signInAs } from '../support/sign-in';
import { mockApi } from './mock-api';

process.env['E2E_DEV_TOKEN_SECRET'] ??= 'collections-specs-secret-0001';

// The trash screen: one row per deleted batch, Restore, and the empty trash. Needs a development build of the client (`bunx vite build --mode e2e`); the API is stood in for by `mockApi`.
const item = (id: string, title: string) => ({ id, title, collectionId: 'c1', deletedAt: Date.UTC(2026, 10, 20, 9, 0), deletedBy: null, daysLeft: 20 });
const page0 = (id: string, title: string) => ({ id, urlId: id.padEnd(8, '0'), parentId: null, position: 'p0000', title, icon: null });

test('lists the deleted pages and restores one', async ({ page, context }) => {
  await signInAs(context, 'e2e-alice', 'member', { check: false });
  const api = await mockApi(page, {
    collections: [{ id: 'c1', name: 'Dev', myPermission: 'read-write' }],
    pages: [],
    trash: [{ item: item('a', 'Plan for May'), pages: [page0('a', 'Plan for May')] }, { item: item('b', 'Old notes'), pages: [page0('b', 'Old notes')] }],
  });
  await page.goto('/trash');
  await expect(page.getByRole('heading', { level: 1, name: 'Trash' })).toBeVisible();
  await expect(page.getByRole('listitem')).toHaveCount(2);
  await expect(page.getByRole('listitem').first()).toContainText('Dev · deleted');
  await expect(page.getByRole('listitem').first()).toContainText('20 days left');

  await page.getByRole('button', { name: 'Restore Plan for May' }).click();
  await expect(page.getByRole('listitem')).toHaveCount(1);
  await expect(page.getByRole('listitem')).toContainText('Old notes');
  expect(api.writes()).toEqual(['POST /v1/trash/a/restore']);
  expect(api.state.pages.map((p) => p.id)).toEqual(['a']); // back in its collection
});

test('says the trash is empty when it is', async ({ page, context }) => {
  await signInAs(context, 'e2e-alice', 'member', { check: false });
  await mockApi(page, { collections: [{ id: 'c1', name: 'Dev', myPermission: 'read-write' }], pages: [], trash: [] });
  await page.goto('/trash');
  await expect(page.getByText('The trash is empty')).toBeVisible();
});
