import { expect, test } from '@playwright/test';
import { makePage } from '../editor/pages';
import { waitForSynced } from '../support/sync';
import { twoUsers } from '../support/two-users';
import { SOFT_LOCK_HELP, blocks, remoteBlocks, surface } from './support';

test.describe('the help of the soft lock', () => {
  test('the "Why?" of the lock message says what the lock protects, in the words of R3.15', async ({ browser, baseURL }) => {
    test.slow();
    const made = await makePage('First paragraph.\n\nSecond paragraph, where Bob is.\n');
    const users = await twoUsers(browser, baseURL);
    try {
      const [a, b] = [users.a.page, users.b.page];
      for (const page of [a, b]) {
        await page.goto(made.path);
        await waitForSynced(page);
      }
      const target = (await blocks(a))[1]!;
      await surface(b).locator('p', { hasText: 'Second paragraph' }).click();
      await expect.poll(async () => (await remoteBlocks(a)).map((r) => r.blockId), { timeout: 15_000 }).toContain(target.id);
      await surface(a).locator('p', { hasText: 'Second paragraph' }).hover();
      await a.getByRole('button', { name: 'Block menu' }).click();
      await a.getByRole('option', { name: /^Quote/ }).click();
      const why = a.getByRole('button', { name: 'Why?' });
      await expect(why).toHaveAttribute('aria-expanded', 'false');
      await why.click();
      await expect(why).toHaveAttribute('aria-expanded', 'true');
      await expect(a.getByRole('alert').locator('.lock-help p').first()).toHaveText(SOFT_LOCK_HELP);
    } finally {
      await users.close();
    }
  });
});
