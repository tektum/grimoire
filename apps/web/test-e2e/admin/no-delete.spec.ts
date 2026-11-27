import { expect, test } from '@playwright/test';
import { signInAs } from '../support/sign-in';
import { adminApi } from './mock-api';

// A user is never deleted (decision 148): the users screen has no element named Delete (or Remove) for a user, only Suspend or Reinstate.
test('the users screen offers Suspend or Reinstate and nothing that deletes a user', async ({ page, context }) => {
  await signInAs(context, 'e2e-alice', 'admin', { check: false });
  await adminApi(page, { role: 'admin', users: [
    { id: 'u1', name: 'Alice', email: 'alice@dev.invalid', role: 'admin', suspended: false },
    { id: 'u2', name: 'Carol', email: 'carol@dev.invalid', role: 'viewer', suspended: true },
  ] });
  await page.goto('/admin/users');
  await expect(page.getByRole('main').getByRole('listitem')).toHaveCount(2);
  expect(await page.getByRole('button', { name: /delete|remove/i }).count()).toBe(0);
  expect(await page.getByRole('menuitem', { name: /delete|remove/i }).count()).toBe(0);
  await expect(page.getByRole('button', { name: 'Suspend Alice' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reinstate Carol' })).toBeVisible();
});
