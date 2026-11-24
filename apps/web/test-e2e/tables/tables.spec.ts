import { expect, test } from '@playwright/test';
import { makePage } from '../editor/pages';
import { signInAs } from '../support/sign-in';
import { waitForSynced } from '../support/sync';
import { expectSaved } from './saved';

// Needs the whole stack, like the other specs of the live editor: the controls of a table change the table and the saved Markdown follows.
test.describe('table controls on a live page', () => {
  test('in a 2x2 table Add row below gives 3 rows, and the saved Markdown is the 3-row pipe table', async ({ browser, baseURL }) => {
    const made = await makePage('# Tables\n\n| a | b |\n| - | - |\n| 1 | 2 |\n', { permission: 'read_write' });
    const context = await browser.newContext({ ...(baseURL === undefined ? {} : { baseURL }), viewport: { width: 1280, height: 800 } });
    try {
      await signInAs(context, 'e2e-alice', 'member');
      const page = await context.newPage();
      await page.goto(made.path);
      await waitForSynced(page);
      await page.locator('.ProseMirror td').first().click();
      await expect(page.locator('.ProseMirror tr')).toHaveCount(2);
      await page.getByRole('toolbar', { name: 'Table controls' }).getByRole('button', { name: 'Add row below' }).click();
      await expect(page.locator('.ProseMirror tr')).toHaveCount(3);
      await expectSaved(made.id, '| a | b |\n| - | - |\n| 1 | 2 |\n|   |   |');
    } finally {
      await context.close();
    }
  });

  test('in a table of 3 columns Delete column gives 2 columns on 2 rows, and the saved Markdown is the pipe table without it', async ({ browser, baseURL }) => {
    const made = await makePage('# Tables\n\n| a | b | c |\n| - | - | - |\n| 1 | 2 | 3 |\n', { permission: 'read_write' });
    const context = await browser.newContext({ ...(baseURL === undefined ? {} : { baseURL }), viewport: { width: 1280, height: 800 } });
    try {
      await signInAs(context, 'e2e-alice', 'member');
      const page = await context.newPage();
      await page.goto(made.path);
      await waitForSynced(page);
      await page.locator('.ProseMirror td').nth(1).click();
      await page.getByRole('toolbar', { name: 'Table controls' }).getByRole('button', { name: 'Delete column' }).click();
      await expect(page.locator('.ProseMirror tr').first().locator('th, td')).toHaveCount(2);
      await expect(page.locator('.ProseMirror tr')).toHaveCount(2);
      await expectSaved(made.id, '| a | c |\n| - | - |\n| 1 | 3 |');
    } finally {
      await context.close();
    }
  });
});
