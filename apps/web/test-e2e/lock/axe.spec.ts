import { expect, test } from '@playwright/test';
import { expectNoAxeViolations } from '../support/axe';
import { waitForSynced } from '../support/sync';
import { twoUsers } from '../support/two-users';
import { makePage } from '../editor/pages';
import { blocks, remoteBlocks, surface } from './support';

test.describe('accessibility of the editor menus', () => {
  test('no serious or critical violation with the slash menu open', async ({ browser, baseURL }) => {
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
      await page.getByRole('option').first().waitFor();
      await expect(page.locator('.slash-host')).toHaveCSS('opacity', '1'); // the menu fades in: axe measures contrast through the opacity of the moment
      await expectNoAxeViolations(page);
    } finally {
      await users.close();
    }
  });

  test('no serious or critical violation with the block handle and its menu open', async ({ browser, baseURL }) => {
    const made = await makePage('Some words.\n');
    const users = await twoUsers(browser, baseURL);
    try {
      const { page } = users.a;
      await page.goto(made.path);
      await waitForSynced(page);
      await surface(page).locator('p').first().hover();
      await page.getByRole('button', { name: 'Block menu' }).press('Enter'); // from the keyboard: the list takes the focus (a click hands it back to the text)
      const list = page.getByRole('listbox', { name: 'Turn this block into' });
      await expect(list).toBeFocused();
      await expect(list).toHaveAttribute('aria-activedescendant', /option-text$/);
      await page.keyboard.press('ArrowDown');
      await expect(list).toHaveAttribute('aria-activedescendant', /option-heading-1$/);
      await expect(page.locator('.block-handle-menu')).toHaveCSS('opacity', '1'); // fully faded in: axe measures contrast through the opacity of the moment
      await expectNoAxeViolations(page);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('button', { name: 'Block menu' })).toBeFocused();
    } finally {
      await users.close();
    }
  });

  test('no serious or critical violation with the bubble open, and with its link editor showing a refusal', async ({ browser, baseURL }) => {
    const made = await makePage('selectable\n');
    const users = await twoUsers(browser, baseURL);
    try {
      const { page } = users.a;
      await page.goto(made.path);
      await waitForSynced(page);
      await surface(page).getByText('selectable').dblclick(); // one word: a double click on the middle of the paragraph selects it
      await page.getByRole('toolbar', { name: 'Text formatting' }).waitFor();
      await expectNoAxeViolations(page);
      await page.getByRole('button', { name: 'Link' }).click();
      await page.getByRole('textbox', { name: 'Link address' }).fill('javascript:alert(1)');
      await page.keyboard.press('Enter');
      await page.getByRole('alert').waitFor();
      await expectNoAxeViolations(page);
    } finally {
      await users.close();
    }
  });

  test('no serious or critical violation with the lock message open, with its help showing, and on the help page', async ({ browser, baseURL }) => {
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
      await expectNoAxeViolations(a); // with the handle menu open
      await a.getByRole('option', { name: /^Quote/ }).click();
      await a.getByRole('alert').waitFor();
      await a.getByRole('button', { name: 'Why?' }).click();
      await expectNoAxeViolations(a);
      await a.goto('/help');
      await a.getByRole('heading', { name: 'Editing together' }).waitFor();
      await expectNoAxeViolations(a);
    } finally {
      await users.close();
    }
  });
});
