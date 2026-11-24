import { expect, test } from '@playwright/test';
import { signInAs } from '../support/sign-in';
import { mockApi } from './mock-api';

process.env['E2E_DEV_TOKEN_SECRET'] ??= 'collections-specs-secret-0001';

// A collection the person may not read and one that does not exist look the same: the same screen with the same text, and the API answered both with 404 (it never says
// which). So does an address that leads nowhere. Needs a development build of the client (`bunx vite build --mode e2e`); the API is stood in for by `mockApi`.
// The same check for `/p/<slug>` belongs to the page screen, when that screen exists.
test('no access, no such collection and no such address show one screen with one text', async ({ page, context }) => {
  await signInAs(context, 'e2e-alice', 'member', { check: false });
  await mockApi(page, { collections: [{ id: 'c1', name: 'Dev', myPermission: 'read-write' }], pages: [], hidden: ['secret'] });
  const statuses: number[] = [];
  page.on('response', (r) => { if (/\/v1\/collections\/[^/]+$/.test(r.url())) statuses.push(r.status()); });
  const seen: string[] = [];
  for (const address of ['/c/secret', '/c/00000000-0000-4000-8000-000000000000', '/nowhere/at-all']) {
    await page.goto(address);
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
    seen.push(await page.locator('section[aria-labelledby="screen-title"]').innerText()); // the screen itself, not the collection list beside it
  }
  expect(new Set(seen).size).toBe(1);
  expect(seen[0]).toContain("This page doesn't exist, or you don't have access to it.");
  expect(statuses).toEqual([404, 404]); // both collection reads, the same status
});
