import { expect, test } from '@playwright/test';
import { openEditor } from './support';

// The language picker in a real browser on the editor in a page of the spec's own server (no stack): it has a name, sets the language, is reached by the keyboard, and the
// Markdown fence follows.
const TEXT = 'Before.\n\n```\nconst a: number = 1;\n```\n\nAfter.\n';

test('selecting ts in the picker of a code block gives the fence ```ts', async ({ page }) => {
  const editor = await openEditor(page, TEXT);
  try {
    await expect(page.getByRole('combobox', { name: 'Language of this code block' })).toHaveCount(0);
    await page.locator('pre').click();
    const picker = page.getByRole('combobox', { name: 'Language of this code block' });
    await expect(picker).toHaveValue('');
    await picker.selectOption('ts');
    await expect(picker).toHaveValue('ts');
    expect(await editor.markdown()).toContain('```ts\nconst a: number = 1;\n```');
  } finally {
    await editor.stop();
  }
});

test('the keyboard reaches the picker from the code, changes the language by typing in it, and the picker keeps the focus', async ({ page }) => {
  const editor = await openEditor(page, TEXT);
  try {
    await page.locator('pre').click();
    await page.keyboard.press('Tab');
    const picker = page.getByRole('combobox', { name: 'Language of this code block' });
    await expect(picker).toBeFocused();
    await page.keyboard.type('json');
    await expect(picker).toHaveValue('json');
    await expect(picker).toBeFocused();
    expect(await editor.markdown()).toContain('```json\nconst a: number = 1;\n```');
  } finally {
    await editor.stop();
  }
});
