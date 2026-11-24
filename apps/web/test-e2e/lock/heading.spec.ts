import { expect, test } from '@playwright/test';
import { waitForSynced } from '../support/sync';
import { twoUsers } from '../support/two-users';
import { makePage } from '../editor/pages';
import { blocks, surface } from './support';

test.describe('a heading level changed while someone types in the block', () => {
  test('both edits are there afterwards and the block is the same element in both tabs', async ({ browser, baseURL }) => {
    test.slow();
    const made = await makePage('Above.\n\nThe paragraph that gets a level.\n\nBelow.\n');
    const users = await twoUsers(browser, baseURL);
    try {
      const [a, b] = [users.a.page, users.b.page];
      for (const page of [a, b]) {
        await page.goto(made.path);
        await waitForSynced(page);
      }
      const before = await blocks(a);
      await surface(b).locator('p', { hasText: 'The paragraph that gets a level.' }).click();
      await b.keyboard.press('End');
      await surface(a).locator('p', { hasText: 'The paragraph that gets a level.' }).click();
      // B types, a letter every 60 ms, while A gives the block level 2 with the keyboard.
      const typing = b.keyboard.type(' Bob adds words.', { delay: 60 });
      await expect.poll(async () => (await blocks(a))[1]?.text, { message: 'B has started typing, as A sees it' }).toContain(' Bob');
      await a.keyboard.press('Control+Alt+2');
      await typing;
      for (const page of [a, b]) {
        await expect.poll(async () => (await blocks(page))[1]?.level, { timeout: 15_000 }).toBe(2);
        await expect.poll(async () => (await blocks(page))[1]?.text, { timeout: 15_000 }).toBe('The paragraph that gets a level. Bob adds words.');
        const after = await blocks(page);
        expect(
          after.map((block) => block.id),
          'no block was replaced by a new one',
        ).toEqual(before.map((block) => block.id));
      }
    } finally {
      await users.close();
    }
  });
});
