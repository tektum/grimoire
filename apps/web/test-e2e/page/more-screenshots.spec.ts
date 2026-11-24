import { expect, test } from '@playwright/test';
import { shots } from '../support/shots';
import { SAVED_PAGE, openShots, p, settled } from './shot-support';

// The More menu of the page head, light and dark, 1280 by 800 (test-results/shots/M6-MORE/): closed, open for an administrator, open for a member. Against a stand-in of the API (see
// `shot-support.ts` for the editor's collaboration server and the font). Run by the same command as the other browser tests.
const TASK = 'M6-MORE';

for (const role of ['admin', 'member'] as const) {
  test(`the page head and its More menu for ${role === 'admin' ? 'an administrator' : 'a member'}`, async ({ page, context, browserName }) => {
    test.skip(browserName !== 'chromium', 'screenshots are taken once, in Chromium');
    await openShots(page, context, [p(SAVED_PAGE.id, null, 'p0000', 'Plan', SAVED_PAGE.urlId), p('b', null, 'p0001', 'Meeting notes')], { role });
    await page.goto(`/p/plan-${SAVED_PAGE.urlId}`);
    await expect(page.getByTestId('user-role')).toHaveText(role);
    await settled(page, 2);
    if (role === 'admin') await shots(page, TASK, 'closed');
    await page.getByRole('button', { name: 'More page actions' }).click();
    await expect(page.getByRole('menuitem', { name: 'History' })).toBeVisible();
    await shots(page, TASK, `open-${role}`);
  });
}
