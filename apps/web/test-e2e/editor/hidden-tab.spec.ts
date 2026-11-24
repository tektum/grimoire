import { expect, test } from '@playwright/test';
import { apiUrl } from '../support/env';
import { waitForSynced } from '../support/sync';
import { twoUsers } from '../support/two-users';
import { makePage } from './pages';

/** A tab cannot really be hidden by a test: the page is told it is, the way the browser tells it. */
const setVisibility = (page: import('@playwright/test').Page, state: 'hidden' | 'visible') =>
  page.evaluate((value) => {
    Object.defineProperty(document, 'visibilityState', { value, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);

test.describe('a hidden tab', () => {
  test('lets go of its connection 3 s after it is hidden and connects again when it is shown, without losing what it holds', async ({ browser, baseURL }) => {
    const made = await makePage('# Hidden\n\nStays as it is.\n');
    const users = await twoUsers(browser, baseURL);
    try {
      const { page } = users.a;
      // The setting of the test build: `hiddenDisconnectMs` is a field of `config.json`.
      await page.route('**/config.json', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ apiUrl: apiUrl(), hiddenDisconnectMs: 3000 }) }));
      await page.goto(made.path);
      await waitForSynced(page);
      const root = page.getByTestId('editor-root');

      await setVisibility(page, 'hidden');
      await expect(root).toHaveAttribute('data-collab-state', 'synced'); // not at once
      await expect(root).toHaveAttribute('data-collab-state', 'disconnected', { timeout: 8000 });
      await expect(page.locator('.ProseMirror')).toContainText('Stays as it is.');

      await setVisibility(page, 'visible');
      await waitForSynced(page);
      await expect(root).toHaveAttribute('data-collab-state', 'synced');
      await expect(page.locator('.ProseMirror')).toContainText('Stays as it is.');

      // And it is a working connection: what the other person types arrives.
      await users.b.page.goto(made.path);
      await waitForSynced(users.b.page);
      await users.b.page.locator('.ProseMirror p', { hasText: 'Stays as it is.' }).click();
      await users.b.page.keyboard.press('End');
      await users.b.page.keyboard.type(' Seen after.');
      await expect(page.locator('.ProseMirror')).toContainText('Seen after.');
    } finally {
      await users.close();
    }
  });
});
