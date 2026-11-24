import { expect, test } from '@playwright/test';
import { signInAs } from '../support/sign-in';
import { historyApi, SLUG, type MockRevision } from './mock-api';

process.env['E2E_DEV_TOKEN_SECRET'] ??= 'history-specs-secret-0000001';

// Restore answered 409 `markdown_stale` (route interception): the message says the page is still being saved, the version stays open, nothing navigates; a second try
// that is answered 200 restores and goes to the page. The page screen itself applies the Markdown (M6-T04), so only the address is checked here.
const revision: MockRevision = {
  id: 'r1',
  createdAt: Date.UTC(2026, 10, 20, 14, 30),
  title: 'Quarterly plan',
  reason: 'idle',
  lastAuthor: { id: 'u1', name: 'Alice Example' },
  authors: [{ id: 'u1', name: 'Alice Example' }],
  markdown: '# Quarterly plan\n\nThe older text\n',
};

test('a stale answer keeps the version open with the message, and the next try restores and goes to the page', async ({ page, context }) => {
  await signInAs(context, 'e2e-alice', 'member', { check: false });
  const api = await historyApi(page, { role: 'member', current: '# Quarterly plan\n\nThe newer text\n', revisions: [revision], staleRestores: 1 });
  await page.goto(`/p/${SLUG}/history/r1`);
  await page.getByRole('button', { name: 'Restore this version' }).click();
  await page.getByRole('alertdialog', { name: 'Restore this version?' }).getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByRole('alert')).toHaveText('The page is still being saved. Try again in a moment.');
  await expect(page).toHaveURL(new RegExp(`/p/${SLUG}/history/r1$`));
  await expect(page.locator('#screen-title').filter({ hasText: 'Quarterly plan' })).toBeVisible();
  expect(api.restored).toEqual([]);

  await page.getByRole('button', { name: 'Restore this version' }).click();
  await page.getByRole('alertdialog', { name: 'Restore this version?' }).getByRole('button', { name: 'Restore' }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${SLUG}$`));
  expect(api.restored).toEqual(['r1']);
  expect(api.seen.filter((line) => line.startsWith('POST') && line.endsWith('/restore'))).toHaveLength(2);
});
