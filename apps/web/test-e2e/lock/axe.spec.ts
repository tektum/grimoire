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

  test('no serious or critical violation with the bubble open, and with its link editor showing a refusal', async ({ browser, baseURL }) => {
    const made = await makePage('selectable\n');
    const users = await twoUsers(browser, baseURL);
    try {
      const { page } = users.a;
      await page.goto(made.path);
      await waitForSynced(page);
      await surface(page).getByText('selectable').dblclick(); // one word: a double click on the middle of the paragraph selects it
      await page.getByRole('toolbar', { name: 'Text formatting' }).waitFor();
      await expectNoAxeViolations(page);
      await page.getByRole('button', { name: 'Link' }).click();
      await page.getByRole('textbox', { name: 'Link address' }).fill('javascript:alert(1)');
      await page.keyboard.press('Enter');
      await page.getByRole('alert').waitFor();
      await expectNoAxeViolations(page);
    } finally {
      await users.close();
    }
  });
});
