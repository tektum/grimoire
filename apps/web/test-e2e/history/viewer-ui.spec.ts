import { expect, test } from '@playwright/test';
import { signInAs } from '../support/sign-in';
import { historyApi, PAGE_ID, SLUG, type MockRevision } from './mock-api';
import { API } from '../collections/mock-api';

// A viewer reads the list and a version, and sees no Restore button. Against the stand-in API, which answers a viewer's restore 403 as the server does (the server's
// own 403 is tested in apps/server/test/routes/revisions.test.ts, and with the real stack in viewer.spec.ts).
const revision: MockRevision = {
  id: 'r1',
  createdAt: Date.UTC(2026, 10, 20, 14, 30),
  title: 'Quarterly plan',
  reason: 'idle',
  lastAuthor: { id: 'u1', name: 'Alice Example' },
  authors: [{ id: 'u1', name: 'Alice Example' }],
  markdown: '# Quarterly plan\n\nThe older text\n',
};

test('a viewer sees the version and the changes, and no element with role button named Restore', async ({ page, context }) => {
  await signInAs(context, 'e2e-vera', 'viewer', { check: false });
  await historyApi(page, { role: 'viewer', current: '# Quarterly plan\n\nThe newer text\n', revisions: [revision] });
  await page.goto(`/p/${SLUG}/history`);
  await expect(page.getByRole('listitem')).toHaveCount(1);
  await page.getByRole('link', { name: /Open this version/ }).click();
  await expect(page.locator('#screen-title').filter({ hasText: 'Quarterly plan' })).toBeVisible();
  await page.getByRole('tab', { name: 'Changes' }).click();
  await expect(page.getByRole('tabpanel').locator('ins').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Restore/ })).toHaveCount(0);
  const answer = await page.evaluate(async ([api, id]) => (await fetch(`${api}/v1/pages/${id}/revisions/r1/restore`, { method: 'POST' })).status, [API, PAGE_ID] as const);
  expect(answer).toBe(403);
});
