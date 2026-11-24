import { expect, test } from '@playwright/test';
import { makePage } from '../editor/pages';
import { signInAs } from '../support/sign-in';
import { waitForSynced } from '../support/sync';

// Needs the whole stack: every control of a table has an accessible name, and the Tab key reaches each of them in turn from the last cell.
test('every table control has an accessible name and is reached by Tab from the last cell', async ({ browser, baseURL }) => {
  const made = await makePage('# Tables\n\n| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n\nAfter.\n', { permission: 'read_write' });
  const context = await browser.newContext({ ...(baseURL === undefined ? {} : { baseURL }), viewport: { width: 1280, height: 800 } });
  try {
    await signInAs(context, 'e2e-alice', 'member');
    const page = await context.newPage();
    await page.goto(made.path);
    await waitForSynced(page);
    await page.locator('.ProseMirror td').last().click();
    const toolbar = page.getByRole('toolbar', { name: 'Table controls' });
    const names = await toolbar.getByRole('button').evaluateAll((all) => all.map((b) => b.getAttribute('aria-label')));
    expect(names).toEqual(['Add row above', 'Add row below', 'Add column left', 'Add column right', 'Delete row', 'Delete column']);
    await page.keyboard.press('Tab');
    const reached: string[] = [];
    for (let i = 0; i < names.length; i += 1) {
      reached.push(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? ''));
      await page.keyboard.press('Tab');
    }
    expect(reached).toEqual(names);
  } finally {
    await context.close();
  }
});
