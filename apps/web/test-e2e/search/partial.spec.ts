import { expect, test } from '@playwright/test';
import { mockApi } from '../collections/mock-api';
import { signInAs } from '../support/sign-in';
import { hit, scriptedSearch } from './support';

// A page that is only partly indexed says so (R9.7, Q35 = B), and a typo in a title still finds it (Q36 = B: the typo tolerance is the server's, so here the scripted search answers as it would). Against
// the stand-in of the API and the scripted search; the same specification runs against the stack with M7-T01.
const NOTICE = 'Only the beginning of this page is searchable';

test('a result with partial: true shows the notice and one without it does not', async ({ page, context }) => {
  await signInAs(context, 'e2e-alice', 'member', { check: false });
  await mockApi(page, { collections: [{ id: 'c1', name: 'Dev', myPermission: 'read-write' }], pages: [] });
  await scriptedSearch(page, () => ({ items: [hit('big', 'b1000000', 'A very long page', 'word1 word2', [[0, 5]], { partial: true }), hit('small', 's1000000', 'A short page', 'word1', [[0, 5]])] }));
  await page.goto('/search?q=word1');
  const big = page.getByRole('main').getByRole('listitem').filter({ hasText: 'A very long page' });
  const small = page.getByRole('main').getByRole('listitem').filter({ hasText: 'A short page' });
  await expect(big.getByText(NOTICE)).toBeVisible();
  await expect(small).toBeVisible();
  await expect(small.getByText(NOTICE)).toHaveCount(0);
  await expect(page.getByText(NOTICE)).toHaveCount(1);
});

test('a typo query finds the page titled Quarterly planning', async ({ page, context }) => {
  await signInAs(context, 'e2e-alice', 'member', { check: false });
  await mockApi(page, { collections: [{ id: 'c1', name: 'Dev', myPermission: 'read-write' }], pages: [] });
  const search = await scriptedSearch(page, (q) => ({ items: q === 'quartrly plannng' ? [hit('q', 'q1000000', 'Quarterly planning', 'goals for the quarter', [])] : [] }));
  await page.goto('/search');
  await page.getByRole('searchbox', { name: 'Search pages' }).fill('quartrly plannng');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('link', { name: 'Quarterly planning' })).toBeVisible();
  expect(search.requests.map((r) => r.q)).toEqual(['quartrly plannng']);
});
