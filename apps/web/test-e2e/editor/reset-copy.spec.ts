import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { waitForSynced } from '../support/sync';
import { twoUsers } from '../support/two-users';
import { makePage, resetPageState } from './pages';

test.describe('a page that is reset under a tab with unsent changes', () => {
  test('says so, keeps a copy to download or copy, and reopens the page as it was reset', async ({ browser, baseURL }) => {
    const made = await makePage('# Reset\n\nThe page as saved.\n', { title: 'Reset plan' });
    const users = await twoUsers(browser, baseURL);
    try {
      const { page, context } = users.a;
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL! });
      await page.goto(made.path);
      await waitForSynced(page);
      await page.locator('.ProseMirror p', { hasText: 'The page as saved.' }).click();
      await page.keyboard.press('End');
      await page.keyboard.type(' My unsent words.');
      await expect(page.locator('.ProseMirror')).toContainText('My unsent words.');

      await resetPageState(made.id, { confirmStale: true });

      const notice = page.getByRole('alert').filter({ hasText: 'This page was reset. Your unsent changes were not applied.' });
      await expect(notice).toBeVisible();
      await expect(notice.getByRole('button')).toHaveText(['Download my copy', 'Copy to clipboard', 'Dismiss']);

      const download = page.waitForEvent('download');
      await notice.getByRole('button', { name: 'Download my copy' }).click();
      const file = await download;
      expect(file.suggestedFilename()).toBe('Reset plan-your-copy.md');
      expect(readFileSync((await file.path())!, 'utf8')).toContain('My unsent words.');

      await notice.getByRole('button', { name: 'Copy to clipboard' }).click();
      await expect(notice.getByText('Copied.')).toBeVisible();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('My unsent words.');

      // The page itself is the reset one, once, with no loop: the unsent words are only in the copy.
      await waitForSynced(page);
      await expect(page.locator('.ProseMirror')).toContainText('The page as saved.');
      await expect(page.locator('.ProseMirror')).not.toContainText('My unsent words.');

      // And the old words do not come back: not within 5 s of the reset page showing, and not after a reconnect either.
      const comesBack = async (forMs: number): Promise<boolean> => {
        const start = Date.now();
        let returned = false;
        await expect
          .poll(
            async () => {
              returned ||= (await page.locator('.ProseMirror').innerText()).includes('My unsent words.');
              return Date.now() - start >= forMs;
            },
            { timeout: forMs + 10_000, intervals: [250] },
          )
          .toBe(true);
        return returned;
      };
      expect(await comesBack(5000)).toBe(false);
      await context.setOffline(true);
      await context.setOffline(false);
      await waitForSynced(page);
      expect(await comesBack(2000)).toBe(false);
      await expect(page.locator('.ProseMirror')).toContainText('The page as saved.');

      await notice.getByRole('button', { name: 'Dismiss' }).click();
      await expect(notice).toHaveCount(0);
    } finally {
      await users.close();
    }
  });
});
