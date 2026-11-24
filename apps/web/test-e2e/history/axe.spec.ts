import { expect, test } from '@playwright/test';
import { expectNoAxeViolations } from '../support/axe';
import { signInAs } from '../support/sign-in';
import { historyApi, SLUG, type MockRevision } from './mock-api';

// No serious or critical accessibility violation on the list, one version and its changes, in light and dark. Needs a development build of the client
// (`bunx vite build --mode e2e`); the API is stood in for by `historyApi`.
const revision = (id: string, over: Partial<MockRevision> = {}): MockRevision => ({
  id,
  createdAt: Date.UTC(2026, 10, 20, 14, 30),
  title: 'Quarterly plan',
  reason: 'idle',
  lastAuthor: { id: 'u1', name: 'Alice Example' },
  authors: [{ id: 'u1', name: 'Alice Example' }, { id: 'u2', name: 'Bob Builder' }],
  markdown: '# Quarterly plan\n\nThe older text\n\n- one\n- two\n',
  ...over,
});
const STATE = { role: 'member' as const, current: '# Quarterly plan\n\nThe newer text\n\n- one\n- three\n', revisions: [revision('r2', { reason: 'last_editor_left' }), revision('r1', { reason: 'before_restore', lastAuthor: null, authors: [] })] };

for (const scheme of ['light', 'dark'] as const) {
  test(`the list, one version and its changes have no serious or critical violation (${scheme})`, async ({ page, context }) => {
    await signInAs(context, 'e2e-alice', 'member', { check: false });
    await historyApi(page, STATE);
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(`/p/${SLUG}/history`);
    await expect(page.getByRole('listitem')).toHaveCount(2);
    await expectNoAxeViolations(page, { minImpact: 'serious' });
    await page.getByRole('link', { name: /Open this version/ }).first().click();
    await expect(page.getByRole('heading', { level: 1, name: 'Quarterly plan' })).toBeVisible();
    await expect(page.getByTestId('revision-text').locator('.ProseMirror')).toBeVisible();
    await expectNoAxeViolations(page, { minImpact: 'serious' });
    await page.getByRole('tab', { name: 'Changes' }).click();
    await expect(page.getByRole('tabpanel').locator('ins').first()).toBeVisible();
    await expectNoAxeViolations(page, { minImpact: 'serious' });
  });
}
