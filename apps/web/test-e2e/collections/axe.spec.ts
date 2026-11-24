import { expect, test } from '@playwright/test';
import { expectNoAxeViolations } from '../support/axe';
import { signInAs } from '../support/sign-in';
import { mockApi } from './mock-api';

process.env['E2E_DEV_TOKEN_SECRET'] ??= 'collections-specs-secret-0001';

// No serious or critical accessibility violation on the screens of this task, in light and dark. The collection screen is here; the trash and the
// not-found screen are added with their own pull request. Needs a development build of the client (`bunx vite build --mode e2e`).
const page0 = (id: string, parentId: string | null, position: string, title: string) => ({ id, urlId: id.padEnd(8, '0'), parentId, position, title, icon: null });

for (const scheme of ['light', 'dark'] as const) {
  test(`the collection screen has no serious or critical violation (${scheme})`, async ({ page, context }) => {
    await signInAs(context, 'e2e-alice', 'member', { check: false });
    await mockApi(page, {
      collections: [{ id: 'c1', name: 'Dev', myPermission: 'read-write' }, { id: 'c2', name: 'Private', myPermission: 'read-only' }],
      pages: [page0('a', null, 'p1', 'Welcome'), page0('b', 'a', 'p1', 'Nested'), page0('c', null, 'p2', 'Plan')],
    });
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/c/c1');
    await expect(page.getByRole('treeitem')).toHaveCount(3);
    await expectNoAxeViolations(page, { minImpact: 'serious' });
  });
}
