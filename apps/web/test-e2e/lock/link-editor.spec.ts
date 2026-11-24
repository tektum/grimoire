import { expect, test, type Page } from '@playwright/test';
import { waitForSynced } from '../support/sync';
import { twoUsers } from '../support/two-users';
import { makePage } from '../editor/pages';
import { surface } from './support';

const REFUSAL = 'Only web, mail and relative links are allowed';

/** Selects the word under a double click, which brings up the bubble. */
async function selectWord(page: Page, text: string): Promise<void> {
  await surface(page).getByText(text).dblclick();
  await expect(page.getByRole('toolbar', { name: 'Text formatting' })).toBeVisible();
}

test.describe('the link editor of the bubble', () => {
  test('refuses javascript: and file: addresses with the one text, and applies https:, mailto: and relative ones', async ({ browser, baseURL }) => {
    // One word to a paragraph: a double click lands on the middle of the paragraph, which is then the word.
    const made = await makePage('alpha\n\nbeta\n\ngamma\n');
    const users = await twoUsers(browser, baseURL);
    try {
      const { page } = users.a;
      await page.goto(made.path);
      await waitForSynced(page);
      const field = page.getByRole('textbox', { name: 'Link address' });
      await selectWord(page, 'alpha');
      await page.getByRole('button', { name: 'Link' }).click();
      for (const refused of ['javascript:alert(1)', 'file:///etc/passwd']) {
        await field.fill(refused);
        await page.keyboard.press('Enter');
        await expect(page.getByRole('alert')).toHaveText(REFUSAL);
        await expect(field).toHaveValue(refused); // still open, with what was typed
        await expect(surface(page).locator('a')).toHaveCount(0);
      }
      for (const [word, allowed] of [
        ['alpha', 'https://example.com'],
        ['beta', 'mailto:a@b.test'],
        ['gamma', '/p/x'],
      ] as const) {
        if (word !== 'alpha') {
          await selectWord(page, word);
          await page.getByRole('button', { name: 'Link' }).click();
        }
        await field.fill(allowed);
        await page.keyboard.press('Enter');
        await expect(field).toHaveCount(0);
        await expect(surface(page).locator(`a[href="${allowed}"]`)).toHaveText(word);
      }
      await expect(surface(page).locator('a')).toHaveCount(3);
    } finally {
      await users.close();
    }
  });

  test('Mod-K opens it for the selection, Escape leaves it, and Remove link takes a link off', async ({ browser, baseURL }) => {
    const made = await makePage('another\n\n[linked](https://example.com)\n');
    const users = await twoUsers(browser, baseURL);
    try {
      const { page } = users.a;
      await page.goto(made.path);
      await waitForSynced(page);
      await surface(page).locator('p', { hasText: 'another' }).dblclick();
      await page.keyboard.press('Control+k');
      const field = page.getByRole('textbox', { name: 'Link address' });
      await expect(field).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(field).toHaveCount(0);
      await expect(surface(page).locator('a')).toHaveCount(1);
      await surface(page).locator('a').dblclick();
      await page.getByRole('button', { name: 'Link' }).click();
      await expect(field).toHaveValue('https://example.com');
      await page.getByRole('button', { name: 'Remove link' }).click();
      await expect(surface(page).locator('a')).toHaveCount(0);
    } finally {
      await users.close();
    }
  });
});
