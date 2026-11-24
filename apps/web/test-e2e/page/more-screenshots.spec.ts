import { expect, test } from '@playwright/test';
import { mockApi } from '../collections/mock-api';
import { shots } from '../support/shots';
import { signInAs } from '../support/sign-in';

// The More menu of the page head, light and dark, 1280 by 800 (test-e2e results `shots/M6-MORE/`): closed, open for an administrator, open for a member.
// Against a stand-in of the API (the editor has no collaboration server here). Run by the same command as the other browser tests.
const TASK = 'M6-MORE';
const p = (id: string, parentId: string | null, position: string, title: string) => ({ id, urlId: id.padEnd(8, '0'), parentId, position, title, icon: null });

for (const role of ['admin', 'member'] as const) {
  test(`the page head and its More menu for ${role === 'admin' ? 'an administrator' : 'a member'}`, async ({ page, context, browserName }) => {
    test.skip(browserName !== 'chromium', 'screenshots are taken once, in Chromium');
    await signInAs(context, 'e2e-alice', role, { check: false });
    await mockApi(page, { collections: [{ id: 'c1', name: 'Dev', myPermission: 'read-write' }], pages: [p('a', null, 'p0000', 'Quarterly plan'), p('b', null, 'p0001', 'Meeting notes')], role });
    await page.goto('/p/quarterly-plan-a0000000');
    await expect(page.getByTestId('user-role')).toHaveText(role);
    if (role === 'admin') await shots(page, TASK, 'closed');
    await page.getByRole('button', { name: 'More page actions' }).click();
    await expect(page.getByRole('menuitem', { name: 'History' })).toBeVisible();
    await shots(page, TASK, `open-${role}`);
  });
}
