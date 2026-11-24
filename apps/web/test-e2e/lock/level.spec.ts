import { expect, test } from '@playwright/test';
import { waitForSynced } from '../support/sync';
import { twoUsers } from '../support/two-users';
import { makePage } from '../editor/pages';
import { blocks, surface } from './support';

test.describe('heading levels are attributes of the block', () => {
  test('typing "# " at the start of a paragraph sets level 1 on that paragraph: the same element, its text kept, no new block', async ({ browser, baseURL }) => {
    const made = await makePage('First block.\n\nPlain words here.\n\nLast block.\n');
    const users = await twoUsers(browser, baseURL);
    try {
      const { page } = users.a;
      await page.goto(made.path);
      await waitForSynced(page);
      const before = await blocks(page);
      expect(before.map((b) => b.text)).toEqual(['First block.', 'Plain words here.', 'Last block.']);
      await surface(page).locator('p', { hasText: 'Plain words here.' }).click();
      await page.keyboard.press('Home');
      await page.keyboard.type('# ');
      await expect.poll(async () => (await blocks(page))[1]?.level).toBe(1);
      const after = await blocks(page);
      expect(after).toHaveLength(before.length);
      expect(after[1]!.id, 'the same Yjs element, not a new one').toBe(before[1]!.id);
      expect(after[1]!.text).toBe('Plain words here.');
      expect(after.map((b) => b.id)).toEqual(before.map((b) => b.id));
      await expect(surface(page).locator('h1')).toHaveText('Plain words here.');
    } finally {
      await users.close();
    }
  });
});
