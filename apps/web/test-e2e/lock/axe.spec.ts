import { test } from '@playwright/test';
import { expectNoAxeViolations } from '../support/axe';
import { waitForSynced } from '../support/sync';
import { twoUsers } from '../support/two-users';
import { makePage } from '../editor/pages';
import { surface } from './support';

test.describe('accessibility of the editor menus', () => {
  test('no serious or critical violation with the slash menu open', async ({ browser, baseURL }) => {
    const made = await makePage('Some words.\n');
    const users = await twoUsers(browser, baseURL);
    try {
      const { page } = users.a;
      await page.goto(made.path);
      await waitForSynced(page);
      await surface(page).locator('p').last().click();
      await page.keyboard.press('End');
      await page.keyboard.press('Enter');
      await page.keyboard.type('/');
      await page.getByRole('option').first().waitFor();
      await expectNoAxeViolations(page);
    } finally {
      await users.close();
    }
  });
});
