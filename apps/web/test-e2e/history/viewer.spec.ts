import { expect, test } from '@playwright/test';
import { makePage } from '../editor/pages';
import { twoUsers } from '../support/two-users';
import { restoreStatus, sitAndLeave, waitForRevision } from './revisions';

// Needs the whole stack (`make test-m6`): a viewer sees a version and no element with role button named Restore, and a restore call made directly with the
// viewer's token answers 403.
test('a viewer sees no Restore button, and a direct restore call answers 403', async ({ browser, baseURL }) => {
  const made = await makePage('# Viewing\n\nFirst text.\n', { permission: 'read_write' });
  const users = await twoUsers(browser, baseURL, { b: { userId: 'e2e-vera', role: 'viewer' } });
  try {
    await sitAndLeave(users.a.page, made.path, ' Second text.');
    const revisionId = await waitForRevision(made.id, (markdown) => markdown.includes('Second text.'));
    const { page } = users.b;
    await page.goto(`${made.path}/history/${revisionId}`);
    await expect(page.locator('#screen-title')).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Changes' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Restore/ })).toHaveCount(0);
    expect(await restoreStatus(made.id, revisionId, 'e2e-vera', 'viewer')).toBe(403);
  } finally {
    await users.close();
  }
});
