import { expect, test } from '@playwright/test';
import { expectNoAxeViolations } from '../support/axe';
import { signInAs } from '../support/sign-in';
import { adminApi } from './mock-api';

process.env['E2E_DEV_TOKEN_SECRET'] ??= 'admin-specs-secret-000000001';

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
