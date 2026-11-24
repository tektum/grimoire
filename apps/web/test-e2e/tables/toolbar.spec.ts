import { expect, test } from '@playwright/test';
import { openEditor } from './support';

// The table controls in a real browser, on the editor made editable in a page of the spec's own server (no stack): a click on a cell shows them, a click on a control
// changes the table, the Markdown is what the page would save, and the keyboard reaches every control by name.
const TABLE = 'Before.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nAfter.\n';

test('a click in a cell shows the controls; Add row below gives 3 rows and the Markdown of the 3-row table', async ({ page }) => {
  const editor = await openEditor(page, TABLE);
  try {
    await expect(page.getByRole('toolbar', { name: 'Table controls' })).toHaveCount(0);
    await page.locator('td').first().click();
    const toolbar = page.getByRole('toolbar', { name: 'Table controls' });
    await expect(toolbar).toBeVisible();
    await expect(page.locator('tr')).toHaveCount(2);
    await toolbar.getByRole('button', { name: 'Add row below' }).click();
    await expect(page.locator('tr')).toHaveCount(3);
    expect(await editor.markdown()).toContain('| a | b |\n| - | - |\n| 1 | 2 |\n|   |   |\n');
    await page.locator('p', { hasText: 'After.' }).click();
    await expect(toolbar).toHaveCount(0);
  } finally {
    await editor.stop();
  }
});

test('Delete column gives 2 columns on 2 rows from a table of 3 columns', async ({ page }) => {
  const editor = await openEditor(page, 'Before.\n\n| a | b | c |\n| - | - | - |\n| 1 | 2 | 3 |\n\nAfter.\n');
  try {
    await page.locator('td').nth(1).click();
    await page.getByRole('toolbar', { name: 'Table controls' }).getByRole('button', { name: 'Delete column' }).click();
    await expect(page.locator('tr').first().locator('th, td')).toHaveCount(2);
    await expect(page.locator('tr')).toHaveCount(2);
    expect(await editor.markdown()).toContain('| a | c |\n| - | - |\n| 1 | 3 |\n');
  } finally {
    await editor.stop();
  }
});

test('every control has an accessible name and the Tab key reaches each in turn from the last cell', async ({ page }) => {
  const editor = await openEditor(page, 'Before.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n\nAfter.\n');
  try {
    await page.locator('td').last().click();
    const toolbar = page.getByRole('toolbar', { name: 'Table controls' });
    const names = await toolbar.getByRole('button').evaluateAll((all) => all.map((b) => b.getAttribute('aria-label')));
    expect(names).toEqual(['Add row above', 'Add row below', 'Add column left', 'Add column right', 'Delete row', 'Delete column']);
    const reached: string[] = [];
    await page.keyboard.press('Tab'); // out of the last cell, to the first control
    for (let i = 0; i < names.length; i += 1) {
      reached.push(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? ''));
      await page.keyboard.press('Tab');
    }
    expect(reached).toEqual(names);
    // Pressed with the keyboard (Enter), a control acts on the table the cursor is in.
    await page.getByRole('button', { name: 'Add column right' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('tr').first().locator('th, td')).toHaveCount(3);
    expect(await editor.markdown()).toMatch(/\| a \| b \| +\|/);
  } finally {
    await editor.stop();
  }
});
