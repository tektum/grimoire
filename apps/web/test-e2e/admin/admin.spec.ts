import { expect, test } from '@playwright/test';
import { signInAs } from '../support/sign-in';
import { adminApi, type MockUser } from './mock-api';

process.env['E2E_DEV_TOKEN_SECRET'] ??= 'admin-specs-secret-000000001';

// An administrator changes a user's role and suspends a user; each result is read back through the screen after a reload. Needs a development build of the client
// (`bunx vite build --mode e2e`); the API is stood in for by `adminApi`.
const u = (id: string, name: string, role: MockUser['role'] = 'member', suspended = false): MockUser => ({ id, name, email: `${name.toLowerCase()}@dev.invalid`, role, suspended });

test('changes a role and suspends a user, and the screen shows both after a reload', async ({ page, context }) => {
  await signInAs(context, 'e2e-alice', 'admin', { check: false });
  const api = await adminApi(page, { role: 'admin', users: [u('u1', 'Alice', 'admin'), u('u2', 'Bob'), u('u3', 'Carol')] });
  await page.goto('/admin/users');
  await page.getByLabel('Role of Bob').selectOption('viewer');
  await expect(page.getByLabel('Role of Bob')).toHaveValue('viewer');
  await page.getByRole('button', { name: 'Suspend Carol' }).click();
  await page.getByRole('alertdialog', { name: 'Suspend Carol?' }).getByRole('button', { name: 'Suspend' }).click();
  await expect(page.getByRole('button', { name: 'Reinstate Carol' })).toBeVisible();

  await page.reload();
  await expect(page.getByLabel('Role of Bob')).toHaveValue('viewer');
  await expect(page.getByRole('button', { name: 'Reinstate Carol' })).toBeVisible();
  expect(api.state.users.map((x) => [x.name, x.role, x.suspended])).toEqual([['Alice', 'admin', false], ['Bob', 'viewer', false], ['Carol', 'member', true]]);
});

test('searches by name and by email', async ({ page, context }) => {
  await signInAs(context, 'e2e-alice', 'admin', { check: false });
  await adminApi(page, { role: 'admin', users: [u('u1', 'Alice', 'admin'), u('u2', 'Bob'), u('u3', 'Carol')] });
  await page.goto('/admin/users');
  await page.getByRole('searchbox', { name: 'Search users' }).fill('carol@');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByRole('listitem')).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 2, name: 'Carol' })).toBeVisible();
});
