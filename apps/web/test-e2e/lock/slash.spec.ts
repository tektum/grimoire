import { expect, test } from '@playwright/test';
import { waitForSynced } from '../support/sync';
import { twoUsers } from '../support/two-users';
import { makePage } from '../editor/pages';
import { blocks, surface } from './support';

const KINDS = ['Text', 'Heading 1', 'Heading 2', 'Heading 3', 'Heading 4', 'Heading 5', 'Heading 6', 'Bulleted list', 'Numbered list', 'Task list', 'Quote', 'Code block', 'Divider', 'Table', 'Image or file'];

test.describe('the slash menu', () => {
  test('opens on "/" with every block kind of the schema and the file chooser, each with a name, and is operated with the arrow keys and Enter', async ({ browser, baseURL }) => {
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
      const options = page.getByRole('option');
      await expect(options).toHaveCount(KINDS.length);
      for (const [index, kind] of KINDS.entries()) {
        await expect(options.nth(index)).toHaveAccessibleName(new RegExp(`^${kind}`)); // a name, and the kind's own
      }
      await expect(options.first()).toHaveAttribute('aria-selected', 'true');

      // Narrow it, move, choose: "head", down once (Heading 2), Enter.
      await page.keyboard.type('head');
      await expect(options).toHaveCount(6);
      await page.keyboard.press('ArrowDown');
      await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
      await page.keyboard.press('Enter');
      await expect(options).toHaveCount(0);
      const all = await blocks(page);
      expect(all.at(-1)).toMatchObject({ level: 2, text: '' });
      expect(all, 'the slash text is not left behind').toHaveLength(2);
      // The same block is where the cursor is: typing goes into the heading.
      await page.keyboard.type('Chosen');
      await expect(surface(page).locator('h2')).toHaveText('Chosen');

      // Escape closes it; a click on an item chooses that one.
      await page.keyboard.press('Enter');
      await page.keyboard.type('/quote');
      await expect(options).toHaveCount(1);
      await page.keyboard.press('Escape');
      await expect(options).toHaveCount(0);
      await page.keyboard.press('Backspace');
      await expect(options).toHaveCount(1);
      await options.first().click();
      await expect(surface(page).locator('blockquote')).toHaveCount(1);
    } finally {
      await users.close();
    }
  });

  test('a slash inside a line of text does not open it', async ({ browser, baseURL }) => {
    const made = await makePage('Some words.\n');
    const users = await twoUsers(browser, baseURL);
    try {
      const { page } = users.a;
      await page.goto(made.path);
      await waitForSynced(page);
      await surface(page).locator('p').last().click();
      await page.keyboard.press('End');
      await page.keyboard.type(' and / more');
      await expect(page.getByRole('option')).toHaveCount(0);
    } finally {
      await users.close();
    }
  });
});
