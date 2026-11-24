import { expect, test } from '@playwright/test';
import { makePage } from '../editor/pages';
import { twoUsers } from '../support/two-users';
import { waitForSynced } from '../support/sync';

const RAW = '<img src=x onerror="window.__pwned=1">';

test.describe('raw HTML in a page', () => {
  test('is escaped text in a non-editable block with an "Edit source" button, and runs nothing', async ({ browser, baseURL }) => {
    const made = await makePage(`Before\n\n${RAW}\n\nAfter\n`);
    const users = await twoUsers(browser, baseURL);
    try {
      const { page } = users.a;
      const dialogs: string[] = [];
      page.on('dialog', (d) => { dialogs.push(d.message()); void d.dismiss(); });
      await page.goto(made.path);
      await waitForSynced(page);
      const block = page.locator('.ProseMirror .raw-html');
      await expect(block).toHaveCount(1);
      await expect(block).toHaveAttribute('contenteditable', 'false');
      await expect(block.locator('code')).toHaveText(RAW);
      await expect(block.getByRole('button', { name: 'Edit source' })).toBeVisible();
      await expect(page.locator('.ProseMirror img')).toHaveCount(0);
      expect(await page.evaluate(() => (window as unknown as { __pwned?: unknown }).__pwned)).toBeUndefined();
      expect(dialogs).toEqual([]);
    } finally {
      await users.close();
    }
  });
});
