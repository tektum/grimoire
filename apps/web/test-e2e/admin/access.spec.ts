import { expect, test } from '@playwright/test';
import { signInAs } from '../support/sign-in';
import { adminApi } from './mock-api';

process.env['E2E_DEV_TOKEN_SECRET'] ??= 'admin-specs-secret-000000001';

// A member and a viewer who open an admin address see the not-found screen, and the page makes no admin request (the network log of the stand-in).
for (const role of ['member', 'viewer'] as const) {
  test(`a ${role} opening /admin/users sees the not-found screen and no admin request is made`, async ({ page, context }) => {
    await signInAs(context, 'e2e-bob', role, { check: false });
    const api = await adminApi(page, { role, users: [] });
    for (const address of ['/admin/users', '/admin/nothing']) {
      await page.goto(address);
      await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
    }
    expect(api.admin()).toEqual([]);
  });
}
