import { expect, test } from '@playwright/test';
import { adminApi } from '../admin/mock-api';
import { shots } from '../support/shots';
import { signInAs } from '../support/sign-in';

// The way into the workspace's people and groups: an Admin link in the header, for an administrator only, at every width (a phone has no keyboard for the palette). Against the stand-in of the API.
const MOBILE = 390;

test('an administrator sees Admin in the header on a desktop and on a phone, and it opens the users', async ({ page, context }) => {
  await signInAs(context, 'e2e-ada', 'admin', { check: false });
  await adminApi(page, { role: 'admin', users: [] });
  for (const width of [1280, MOBILE]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/search');
    const link = page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Admin' });
    await expect(link).toBeVisible();
    const box = await link.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= width, `the link is inside the ${String(width)} px screen`).toBe(true);
  }
  await page.getByRole('link', { name: 'Admin' }).click();
  await expect(page).toHaveURL(/\/admin\/users$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Users' })).toBeVisible();
});

for (const role of ['member', 'viewer'] as const) {
  test(`a ${role} has no Admin link, at any width`, async ({ page, context }) => {
    await signInAs(context, 'e2e-bob', role, { check: false });
    await adminApi(page, { role, users: [] });
    for (const width of [1280, MOBILE]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/search');
      await expect(page.getByRole('link', { name: 'Search' })).toBeVisible();
      await expect(page.getByTestId('user-role')).toHaveAttribute('data-role', role);
      await expect(page.getByRole('link', { name: 'Admin' })).toHaveCount(0);
    }
  });
}

test('pictures of the header with the Admin link, light and dark, on a desktop and on a phone', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'screenshots are taken once, in Chromium');
  await signInAs(context, 'e2e-ada', 'admin', { check: false });
  await adminApi(page, { role: 'admin', users: [] });
  await page.goto('/search');
  await expect(page.getByRole('link', { name: 'Admin' })).toBeVisible();
  await shots(page, 'admin-entry', 'header-desktop');
  await shots(page, 'admin-entry', 'header-phone', { width: MOBILE });
});
