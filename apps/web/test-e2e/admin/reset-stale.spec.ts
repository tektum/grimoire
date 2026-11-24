import { expect, test } from '@playwright/test';
import { openReset } from './reset-support';

// A saved text older than the page's state (409 `markdown_stale`) is a second question: the warning says the newest edits would be lost, nothing more is sent
// until that is confirmed, and the confirmed call carries `confirmStale: true`. The result then says the saved text was older.
const STALE = { status: 409, body: { error: { code: 'markdown_stale', message: 'x' } } };

test('warns that the newest edits would be lost, sends nothing until confirmed, then sends confirmStale and says the saved text was older', async ({ page }) => {
  const reset = await openReset(page, [STALE, { status: 200, body: { stateEpoch: 3, markdownStale: true } }]);
  try {
    await page.getByRole('dialog').getByRole('button', { name: 'Reset state' }).click();
    const warning = page.getByRole('alertdialog', { name: 'The saved text is older than the page' });
    await expect(warning).toBeVisible();
    await expect(warning).toContainText('newest edits would be lost');
    await expect(warning).toContainText('saved Markdown');
    expect(reset.sent).toEqual([{}]);
    await warning.getByRole('button', { name: 'Reset anyway' }).click();
    await expect(page.getByText(/Its saved text was older than its state/)).toBeVisible();
    expect(reset.sent).toEqual([{}, { confirmStale: true }]);
  } finally {
    await reset.stop();
  }
});

test('Cancel on the warning goes back to the question and sends nothing more', async ({ page }) => {
  const reset = await openReset(page, [STALE]);
  try {
    await page.getByRole('dialog').getByRole('button', { name: 'Reset state' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('dialog', { name: 'Reset the saved state of Quarterly plan?' })).toBeVisible();
    expect(reset.sent).toEqual([{}]);
  } finally {
    await reset.stop();
  }
});
