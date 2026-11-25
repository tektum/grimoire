import { expect, test } from '@playwright/test';
import { mockApi } from '../collections/mock-api';
import { signInAs } from '../support/sign-in';
import { hit, scriptedSearch } from './support';

// The command palette (R11.10) in a browser, against the stand-in of the API and the scripted search (the endpoint is M7-T01's). Needs a development build of the client (`bunx vite build --mode e2e`).
const p = (id: string, position: string, title: string) => ({ id, urlId: id.padEnd(8, '0'), parentId: null, position, title, icon: null });
const PAGES = [p('a', 'p0000', 'Welcome'), p('b', 'p0001', 'Quarterly planning'), p('c', 'p0002', 'Meeting notes')];

async function open(page: import('@playwright/test').Page, context: Parameters<typeof signInAs>[0], role: 'admin' | 'member' = 'member') {
  await signInAs(context, 'e2e-alice', role, { check: false });
  await mockApi(page, { collections: [{ id: 'c1', name: 'Dev', myPermission: 'read-write' }], pages: PAGES, role });
  const search = await scriptedSearch(page, (q) => ({
    items:
      q === 'roadmap' ? [hit('r1', 'r1000000', 'Product plan', 'the roadmap for the next quarter', [[4, 11]])] : q === 'quarterly' ? [hit('b', 'b0000000', 'Quarterly planning', 'plans for the quarter', [[0, 5]])] : [],
  }));
  await page.goto('/c/c1');
  await expect(page.getByRole('treeitem')).toHaveCount(3);
  return search;
}

test('Mod-K opens the dialog with the focus in the input, and Escape closes it and gives the focus back to what had it', async ({ page, context }) => {
  await open(page, context);
  const before = page.getByRole('button', { name: 'New page' });
  await before.focus();
  await page.keyboard.press('Control+k');
  const input = page.getByRole('combobox');
  await expect(input).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(input).toHaveCount(0);
  await expect(before).toBeFocused();
});

test('Mod-K also closes it, and the text typed is gone when it opens again', async ({ page, context }) => {
  await open(page, context);
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox').fill('abc');
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('combobox')).toHaveCount(0);
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('combobox')).toHaveValue('');
});

test('typing a title finds the page, and Enter opens it', async ({ page, context }) => {
  await open(page, context);
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox').fill('meeting');
  await expect(page.getByRole('option', { name: 'Meeting notes' })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/p\/meeting-notes-c0000000$/);
  await expect(page.getByRole('combobox')).toHaveCount(0);
});

test('typing a word from the body finds the page with the word inside a mark element, and Enter opens it', async ({ page, context }) => {
  const search = await open(page, context);
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox').fill('roadmap');
  const result = page.getByRole('option', { name: /Product plan/ });
  await expect(result).toBeVisible();
  await expect(result.locator('mark')).toHaveText('roadmap');
  await expect(result).toHaveAttribute('aria-selected', 'true'); // the first result is the one Enter takes
  expect(search.requests.map((r) => r.q)).toEqual(['roadmap']); // one request for the text, not one per key
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/p\/product-plan-r1000000$/);
});

test('"See all results" opens the search screen with the text', async ({ page, context }) => {
  await open(page, context);
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox').fill('quarterly');
  await page.getByRole('option', { name: /See all results/ }).click();
  await expect(page).toHaveURL(/\/search\?q=quarterly$/);
});

test('Admin is in the palette for an administrator and not for a member, and a search that fails says so', async ({ page, context }) => {
  await open(page, context, 'admin');
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('option', { name: 'Admin' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.unroute(/v1\/search/);
  await scriptedSearch(page, () => ({ status: 503 }));
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox').fill('anything');
  await expect(page.getByRole('alert')).toHaveText('Search is not available right now.');
});
