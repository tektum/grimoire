import { expect, test } from '@playwright/test';
import { COLLAB_COLOURS, colourIndex } from '../../src/ui/collab';
import { waitForSynced } from '../support/sync';
import { twoUsers } from '../support/two-users';
import { makePage, whoIs } from './pages';

test.describe('editing together', () => {
  test("both people edit the same paragraph and both texts survive; the other person's cursor carries the directory name and the colour derived from the id", async ({ browser, baseURL }) => {
    const made = await makePage('# Together\n\nShared paragraph.\n');
    const users = await twoUsers(browser, baseURL);
    try {
      for (const who of [users.a, users.b]) {
        await who.page.goto(made.path);
        await waitForSynced(who.page);
      }
      const [a, b] = await Promise.all([whoIs(users.a.userId), whoIs(users.b.userId)]);

      await users.a.page.locator('.ProseMirror p', { hasText: 'Shared paragraph.' }).click();
      await users.a.page.keyboard.press('Home');
      await users.a.page.keyboard.type('Alpha. ');
      await users.b.page.locator('.ProseMirror p', { hasText: 'Shared paragraph.' }).click();
      await users.b.page.keyboard.press('End');
      await users.b.page.keyboard.type(' Beta.');

      for (const who of [users.a, users.b]) {
        await expect(who.page.locator('.ProseMirror')).toContainText('Alpha.');
        await expect(who.page.locator('.ProseMirror')).toContainText('Beta.');
      }

      // B sees A's cursor, and A sees B's: the label is the directory's name, the caret the colour of the id-derived palette index.
      const seenByB = users.b.page.locator('.ProseMirror-yjs-cursor');
      await expect(seenByB).toHaveCount(1);
      await expect(seenByB.locator('.cursor-label')).toHaveText(a.name);
      expect(await seenByB.evaluate((el) => (el as HTMLElement).style.getPropertyValue('--cursor'))).toBe(COLLAB_COLOURS[colourIndex(a.id)]);
      const seenByA = users.a.page.locator('.ProseMirror-yjs-cursor');
      await expect(seenByA.locator('.cursor-label')).toHaveText(b.name);
      expect(await seenByA.evaluate((el) => (el as HTMLElement).style.getPropertyValue('--cursor'))).toBe(COLLAB_COLOURS[colourIndex(b.id)]);
    } finally {
      await users.close();
    }
  });
});
