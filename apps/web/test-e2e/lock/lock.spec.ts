import { expect, test } from '@playwright/test';
import { makePage, whoIs } from '../editor/pages';
import { waitForSynced } from '../support/sync';
import { twoUsers } from '../support/two-users';
import { blocks, remoteBlocks, surface } from './support';

const SECOND = 'Second paragraph, where Bob is.';

test.describe('the soft lock', () => {
  test('with Bob in a block, choosing a list from the handle menu or the slash menu leaves the block alone and says exactly who is in it; after he moves away the same action works', async ({
    browser,
    baseURL,
  }) => {
    test.slow();
    const made = await makePage(`First paragraph.\n\n${SECOND}\n`);
    const users = await twoUsers(browser, baseURL);
    try {
      const [a, b] = [users.a.page, users.b.page];
      const meB = await whoIs(users.b.userId);
      for (const page of [a, b]) {
        await page.goto(made.path);
        await waitForSynced(page);
      }
      const before = await blocks(a);
      // Bob puts his cursor in the second block; Alice's tab knows it once his awareness has arrived.
      await surface(b).locator('p', { hasText: SECOND }).click();
      await expect.poll(async () => (await remoteBlocks(a)).map((r) => r.blockId), { timeout: 15_000, message: "Bob's block, as Alice's tab has it" }).toContain(before[1]!.id);

      // From the handle menu of the second block.
      await surface(a).locator('p', { hasText: SECOND }).hover();
      await a.getByRole('button', { name: 'Block menu' }).click();
      await a.getByRole('option', { name: /^Bulleted list/ }).click();
      await expect(a.getByRole('alert')).toContainText(`${meB.name} is editing this block`);
      await expect(a.getByRole('alert').locator('.lock-message')).toHaveText(`${meB.name} is editing this block`);
      expect(await blocks(a), 'the block is unchanged: the same element, still a paragraph, the same text').toEqual(before);
      await a.getByRole('button', { name: 'Close' }).click();

      // From the slash menu, typed at the start of that block: the command text goes back, and the block is not turned into a list.
      await surface(a).locator('p', { hasText: SECOND }).click();
      await a.keyboard.press('Home');
      await a.keyboard.type('/bullet');
      await expect(a.getByRole('option')).toHaveCount(1);
      await a.keyboard.press('Enter');
      await expect(a.getByRole('alert').locator('.lock-message')).toHaveText(`${meB.name} is editing this block`);
      const during = await blocks(a);
      expect(during[1]).toMatchObject({ name: 'paragraph', id: before[1]!.id });
      expect(during[1]!.text).toContain(SECOND);
      expect(during).toHaveLength(before.length);
      await a.getByRole('button', { name: 'Close' }).click();
      for (let i = 0; i < '/bullet'.length; i += 1) await a.keyboard.press('Backspace'); // Alice takes her own typing out

      // Bob moves to the first block: the same action works.
      await surface(b).locator('p', { hasText: 'First paragraph.' }).click();
      await expect.poll(async () => (await remoteBlocks(a)).map((r) => r.blockId), { timeout: 15_000 }).not.toContain(before[1]!.id);
      await surface(a).locator('p', { hasText: SECOND }).hover();
      await a.getByRole('button', { name: 'Block menu' }).click();
      await a.getByRole('option', { name: /^Bulleted list/ }).click();
      await expect(surface(a).locator('ul')).toHaveCount(1);
      await expect(a.getByRole('alert')).toHaveCount(0);
    } finally {
      await users.close();
    }
  });
});
