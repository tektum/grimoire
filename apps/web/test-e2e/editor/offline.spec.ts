import { expect, test } from '@playwright/test';
import { waitForSynced } from '../support/sync';
import { twoUsers } from '../support/two-users';
import { makePage } from './pages';

test.describe('offline', () => {
  test('says "Offline: changes kept in this tab" after more than 10 s without a connection, keeps what is typed, and sends it when the connection is back', async ({ browser, baseURL }) => {
    test.slow(); // a minute or more of reconnecting, and a reset, in one test
    const made = await makePage('# Offline\n\nBefore.\n');
    const users = await twoUsers(browser, baseURL);
    try {
      for (const who of [users.a, users.b]) {
        await who.page.goto(made.path);
        await waitForSynced(who.page);
      }
      await users.a.context.setOffline(true);
      await users.a.page.locator('.ProseMirror p', { hasText: 'Before.' }).click();
      await users.a.page.keyboard.press('End');
      await users.a.page.keyboard.type(' Typed offline.');
      await expect(users.a.page.getByText('Offline: changes kept in this tab')).toBeVisible({ timeout: 25_000 });
      await expect(users.a.page.locator('.ProseMirror')).toContainText('Typed offline.');
      await expect(users.b.page.locator('.ProseMirror')).not.toContainText('Typed offline.');

      await users.a.context.setOffline(false);
      await expect(users.b.page.locator('.ProseMirror')).toContainText('Typed offline.', { timeout: 60_000 });
      await waitForSynced(users.a.page);
      await expect(users.a.page.getByText('Offline: changes kept in this tab')).toHaveCount(0);
    } finally {
      await users.close();
    }
  });
});
