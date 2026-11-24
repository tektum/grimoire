import { expect, test } from '@playwright/test';
import { shots } from '../support/shots';
import { signInAs } from '../support/sign-in';
import { adminApi, type MockUser } from './mock-api';

process.env['E2E_DEV_TOKEN_SECRET'] ??= 'admin-specs-secret-000000001';

// Screenshots of the admin screens, light and dark, 1280 by 800, from the built client with the stand-in API (test-results/shots/M6-T12/). This machine's default
// sans-serif is a monospace face, so an installed sans (Liberation Sans) is named for the interface text, as in the other shots.
const TASK = 'M6-T12';
const SANS = ":root { --font-ui: 'Liberation Sans', Arial, sans-serif; } [data-sonner-toaster] { font-family: 'Liberation Sans', Arial, sans-serif; }"; // the notices have a face of their own
const u = (id: string, name: string, role: MockUser['role'] = 'member', suspended = false): MockUser => ({ id, name, email: `${name.toLowerCase().replace(/\s+/g, '.')}@dev.invalid`, role, suspended });

test('the users list with one suspended user, light and dark', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'screenshots are taken once, in Chromium');
  await signInAs(context, 'e2e-alice', 'admin', { check: false });
  await adminApi(page, { role: 'admin', users: [u('u1', 'Alice Example', 'admin'), u('u2', 'Bob Builder'), u('u3', 'Carol Reader', 'viewer', true), u('u4', 'Dana Writer')] });
  await page.goto('/admin/users');
  await page.addStyleTag({ content: SANS });
  await expect(page.getByRole('listitem')).toHaveCount(4);
  await expect(page.getByTestId('user-name')).toHaveText('Alice Example');
  await page.mouse.move(0, 0);
  await shots(page, TASK, 'users');
});

test('the last-admin message, light and dark', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'screenshots are taken once, in Chromium');
  await signInAs(context, 'e2e-alice', 'admin', { check: false });
  await adminApi(page, { role: 'admin', users: [u('u1', 'Alice Example', 'admin'), u('u2', 'Bob Builder')] });
  await page.goto('/admin/users');
  await page.addStyleTag({ content: SANS });
  await page.getByLabel('Role of Alice Example').selectOption('member');
  await expect(page.getByText('There must be at least one admin')).toBeVisible();
  await page.mouse.move(0, 0);
  await shots(page, TASK, 'last-admin');
});
