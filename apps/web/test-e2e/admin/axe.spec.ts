import { expect, test } from '@playwright/test';
import { expectNoAxeViolations } from '../support/axe';
import { signInAs } from '../support/sign-in';
import { adminApi } from './mock-api';

// No serious or critical accessibility violation on the admin screens, in light and dark. Needs a development build of the client (`bunx vite build --mode e2e`).
for (const scheme of ['light', 'dark'] as const) {
  test(`the users screen has no serious or critical violation (${scheme})`, async ({ page, context }) => {
    await signInAs(context, 'e2e-alice', 'admin', { check: false });
    await adminApi(page, { role: 'admin', users: [
      { id: 'u1', name: 'Alice', email: 'alice@dev.invalid', role: 'admin', suspended: false },
      { id: 'u2', name: 'Carol', email: 'carol@dev.invalid', role: 'viewer', suspended: true },
    ] });
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/admin/users');
    await expect(page.getByRole('listitem')).toHaveCount(2);
    await expectNoAxeViolations(page, { minImpact: 'serious' });
  });
}

for (const scheme of ['light', 'dark'] as const) {
  test(`the groups screen, with a group open, has no serious or critical violation (${scheme})`, async ({ page, context }) => {
    await signInAs(context, 'e2e-alice', 'admin', { check: false });
    await adminApi(page, { role: 'admin', groups: [{ id: 'g1', name: 'Team' }], members: { g1: ['u2'] }, users: [
      { id: 'u1', name: 'Alice', email: 'alice@dev.invalid', role: 'admin', suspended: false },
      { id: 'u2', name: 'Carol', email: 'carol@dev.invalid', role: 'viewer', suspended: true },
    ] });
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/admin/groups?group=g1');
    await expect(page.getByRole('heading', { level: 2, name: 'Members of Team' })).toBeVisible();
    await expectNoAxeViolations(page, { minImpact: 'serious' });
  });
}

for (const scheme of ['light', 'dark'] as const) {
  test(`the collection access screen has no serious or critical violation (${scheme})`, async ({ page, context }) => {
    await signInAs(context, 'e2e-alice', 'admin', { check: false });
    await adminApi(page, { role: 'admin', groups: [{ id: 'g1', name: 'Team' }], access: { defaultPermission: 'read', entries: [{ id: 'e1', principalType: 'group', principalId: 'g1', permission: 'read_write' }] }, users: [
      { id: 'u1', name: 'Alice', email: 'alice@dev.invalid', role: 'admin', suspended: false },
      { id: 'u2', name: 'Carol', email: 'carol@dev.invalid', role: 'viewer', suspended: true },
    ] });
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/admin/collections/c1/access');
    await expect(page.getByRole('table', { name: 'Who has access' })).toBeVisible();
    await expectNoAxeViolations(page, { minImpact: 'serious' });
  });
}
