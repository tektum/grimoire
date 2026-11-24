import { expect, test } from '@playwright/test';
import { waitForSynced } from '../support/sync';
import { twoUsers } from '../support/two-users';
import { makePage, readMarkdown } from '../editor/pages';
import { blocks, surface } from './support';

const TABLE = '| Name | Value |\n| --- | --- |\n| one | 1 |\n| two | 2 |\n';

test.describe('the empty paragraph after a last block that is not text', () => {
  test('typing at the end of a document that ends with a table gives the same Markdown after two saves', async ({ browser, baseURL }) => {
    test.slow();
    const made = await makePage(`Intro.\n\n${TABLE}`);
    const users = await twoUsers(browser, baseURL);
    try {
      const { page } = users.a;
      await page.goto(made.path);
      await waitForSynced(page);
      await surface(page).locator('td', { hasText: 'two' }).first().click();
      await page.keyboard.press('End');
      await page.keyboard.type('!');
      await expect.poll(async () => readMarkdown(made.id), { timeout: 30_000, message: 'the first save' }).toContain('two!');
      const first = await readMarkdown(made.id);
      // The empty paragraph the editor puts below the table is in the document, and not in the Markdown.
      expect((await blocks(page)).at(-1)).toMatchObject({ name: 'paragraph', text: '' });
      // A second save: one more change and back.
      await page.keyboard.type('?');
      await expect.poll(async () => readMarkdown(made.id), { timeout: 30_000 }).toContain('two!?');
      await page.keyboard.press('Backspace');
      await expect.poll(async () => readMarkdown(made.id), { timeout: 30_000, message: 'the second save' }).toBe(first);
      expect(await readMarkdown(made.id)).toBe(first);
    } finally {
      await users.close();
    }
  });
});
