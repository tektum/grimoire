import { expect, test } from '@playwright/test';
import { shots } from '../support/shots';
import { signInAs } from '../support/sign-in';
import { adminApi, type MockUser } from './mock-api';
import { openReset } from './reset-support';

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
  await expect(page.getByRole('main').getByRole('listitem')).toHaveCount(4);
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

test('the reset dialog, asked and then at the stale confirmation, light and dark', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'screenshots are taken once, in Chromium');
  const reset = await openReset(page, [{ status: 409, body: { error: { code: 'markdown_stale', message: 'x' } } }], true);
  try {
    const dialog = page.getByRole('dialog', { name: 'Reset the saved state of Quarterly plan?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('textbox', { name: 'Replacement Markdown (optional)' }).fill('# Quarterly plan\n\nThe text to keep.');
    await shots(page, TASK, 'reset-dialog');
    await dialog.getByRole('button', { name: 'Reset state' }).click();
    await expect(page.getByRole('alertdialog', { name: 'The saved text is older than the page' })).toBeVisible();
    await shots(page, TASK, 'reset-stale');
  } finally {
    await reset.stop();
  }
});

test('a group with its members, light and dark', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'screenshots are taken once, in Chromium');
  await signInAs(context, 'e2e-alice', 'admin', { check: false });
  await adminApi(page, {
    role: 'admin',
    users: [u('u1', 'Alice Example', 'admin'), u('u2', 'Bob Builder'), u('u3', 'Carol Reader', 'viewer'), u('u4', 'Dana Writer')],
    groups: [{ id: 'g1', name: 'Platform team' }, { id: 'g2', name: 'Editors' }],
    members: { g1: ['u2', 'u3', 'u4'], g2: ['u4'] },
  });
  await page.goto('/admin/groups?group=g1');
  await page.addStyleTag({ content: SANS });
  await expect(page.getByRole('list', { name: 'Members' }).getByRole('listitem')).toHaveCount(3);
  await page.mouse.move(0, 0);
  await shots(page, TASK, 'group');
});

test('the access table of a collection, light and dark', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'screenshots are taken once, in Chromium');
  await signInAs(context, 'e2e-alice', 'admin', { check: false });
  await adminApi(page, {
    role: 'admin',
    users: [u('u1', 'Alice Example', 'admin'), u('u2', 'Bob Builder')],
    groups: [{ id: 'g1', name: 'Platform team' }],
    access: { defaultPermission: 'read', entries: [{ id: 'e1', principalType: 'group', principalId: 'g1', permission: 'read_write' }, { id: 'e2', principalType: 'user', principalId: 'u2', permission: 'read' }] },
  });
  await page.goto('/admin/collections/c1/access');
  await page.addStyleTag({ content: SANS });
  await expect(page.getByRole('table', { name: 'Who has access' })).toBeVisible();
  await page.mouse.move(0, 0);
  await shots(page, TASK, 'access');
});
