import { expect, test } from '@playwright/test';
import { mockApi } from '../collections/mock-api';
import { signInAs } from '../support/sign-in';
import { hit, scriptedSearch } from './support';

// The results screen: pages of results by cursor, and the empty state. Against the stand-in of the API and the scripted search.
test('paginates with nextCursor: a second request carries the cursor, and the button goes with the last page', async ({ page, context }) => {
  await signInAs(context, 'e2e-alice', 'member', { check: false });
  await mockApi(page, { collections: [{ id: 'c1', name: 'Dev', myPermission: 'read-write' }], pages: [] });
  const search = await scriptedSearch(page, (_q, cursor) =>
    cursor === null ? { items: [hit('a', 'a1000000', 'First page of results', 'one', [])], nextCursor: 'CURSOR-1' } : { items: [hit('b', 'b1000000', 'Second page of results', 'two', [])], nextCursor: null },
  );
  await page.goto('/search?q=page');
  await expect(page.getByRole('link', { name: 'First page of results' })).toBeVisible();
  expect(search.requests).toEqual([{ q: 'page', cursor: null, limit: '20' }]);
  await page.getByRole('button', { name: 'Show more results' }).click();
  await expect(page.getByRole('link', { name: 'Second page of results' })).toBeVisible();
  expect(search.requests.map((r) => r.cursor)).toEqual([null, 'CURSOR-1']);
  await expect(page.getByRole('link', { name: 'First page of results' })).toBeVisible(); // the first page is still there
  await expect(page.getByRole('button', { name: 'Show more results' })).toHaveCount(0);
});

test('shows "No results" for an empty list', async ({ page, context }) => {
  await signInAs(context, 'e2e-alice', 'member', { check: false });
  await mockApi(page, { collections: [{ id: 'c1', name: 'Dev', myPermission: 'read-write' }], pages: [] });
  await scriptedSearch(page, () => ({ items: [] }));
  await page.goto('/search?q=nothing');
  await expect(page.getByText('No results')).toBeVisible();
  await expect(page.getByRole('list')).toHaveCount(0);
});
