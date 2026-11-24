import { expect, test } from '@playwright/test';
import { makePage } from '../editor/pages';
import { twoUsers } from '../support/two-users';
import { waitForSynced } from '../support/sync';

// Needs the whole stack: a heading typed by the second person appears in the first person's outline.
test('a heading typed by the second user appears in the first user\'s outline', async ({ browser, baseURL }) => {
  const made = await makePage('# First heading\n\nText.\n', { permission: 'read_write' });
  const users = await twoUsers(browser, baseURL);
  try {
    for (const who of [users.a, users.b]) {
      await who.page.setViewportSize({ width: 1400, height: 800 });
      await who.page.goto(made.path);
      await waitForSynced(who.page);
    }
    const outline = users.a.page.getByRole('navigation', { name: 'Page outline' }).getByRole('link');
    await expect(outline).toHaveText(['First heading']);
    await users.b.page.locator('.ProseMirror').click();
    await users.b.page.keyboard.press('Control+End');
    await users.b.page.keyboard.press('Enter');
    await users.b.page.keyboard.type('## Typed by the second');
    await expect(outline).toHaveText(['First heading', 'Typed by the second']);
  } finally {
    await users.close();
  }
});
