import { expect, test } from '@playwright/test';
import { signInAs } from '../support/sign-in';
import { adminApi } from './mock-api';

// Demoting or suspending the only administrator is refused (409 `last_admin`): the screen says so in words and keeps the role the server has.
test('demoting the last administrator says there must be at least one, and the role stays admin', async ({ page, context }) => {
  await signInAs(context, 'e2e-alice', 'admin', { check: false });
  const api = await adminApi(page, { role: 'admin', users: [{ id: 'u1', name: 'Alice', email: 'alice@dev.invalid', role: 'admin', suspended: false }] });
  await page.goto('/admin/users');
  await page.getByLabel('Role of Alice').selectOption('member');
  await expect(page.getByText('There must be at least one admin')).toBeVisible();
  await expect(page.getByLabel('Role of Alice')).toHaveValue('admin');
  expect(api.state.users[0]?.role).toBe('admin');
});
