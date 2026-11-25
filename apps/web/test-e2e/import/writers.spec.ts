import { expect, test } from '@playwright/test';
import { mockApi } from '../collections/mock-api';
import { signInAs } from '../support/sign-in';
import { scriptedImports } from './support';

// Only writers see /import (R11.3): a viewer gets the not-found screen, and no import route is asked anything. Against the stand-in of the API.
for (const role of ['member', 'admin'] as const) {
  test(`a ${role} sees the import screen`, async ({ page, context }) => {
    await signInAs(context, 'e2e-alice', role, { check: false });
    await mockApi(page, { collections: [{ id: 'c1', name: 'Dev', myPermission: 'read-write' }], pages: [], role });
    await scriptedImports(page, []);
    await page.goto('/import');
    await expect(page.getByRole('heading', { level: 1, name: 'Import' })).toBeVisible();
  });
}

test('a viewer gets the not-found screen, and nothing is asked of the import routes', async ({ page, context }) => {
  await signInAs(context, 'e2e-vera', 'viewer', { check: false });
  await mockApi(page, { collections: [{ id: 'c1', name: 'Dev', myPermission: 'read-only' }], pages: [], role: 'viewer' });
  const sent = await scriptedImports(page, []);
  await page.goto('/import');
  await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
  await expect(page.getByLabel('Zip file')).toHaveCount(0);
  expect(sent.creates).toEqual([]);
  expect(sent.reads).toBe(0);
});
