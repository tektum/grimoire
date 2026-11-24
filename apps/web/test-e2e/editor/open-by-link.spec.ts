import { expect, test } from '@playwright/test';
import { waitForSynced } from '../support/sync';
import { twoUsers } from '../support/two-users';
import { makePage, setDefaultPermission } from './pages';

test.describe('opening a page from a pasted link', () => {
  test('a link to a page the person can read opens it, whatever the words before the id say', async ({ browser, baseURL }) => {
    const made = await makePage('# Linked\n\nOpened from a pasted link.\n', { title: 'Linked page' });
    const users = await twoUsers(browser, baseURL);
    try {
      const { page } = users.a;
      await page.goto(`/p/some-other-words-${made.urlId}`);
      await waitForSynced(page);
      await expect(page.getByTestId('editor-root')).toContainText('Opened from a pasted link.');
    } finally {
      await users.close();
    }
  });

  test('an unknown id and a page the person may not read show the same not-found screen', async ({ browser, baseURL }) => {
    const closed = await makePage('# Closed\n\nNot for this person.\n');
    await setDefaultPermission(closed.collectionId, null);
    const users = await twoUsers(browser, baseURL);
    try {
      const { page } = users.a;
      const heading = page.getByRole('heading', { name: 'Page not found' });
      await page.goto('/p/page-zzzzzz');
      await expect(heading).toBeVisible();
      const unknown = await page.locator('.shell-main').innerText();
      await page.goto(`/p/page-${closed.urlId}`);
      await expect(heading).toBeVisible();
      expect(await page.locator('.shell-main').innerText(), 'nothing tells a page that is not there from one that may not be read').toBe(unknown);
      await expect(page.getByTestId('editor-root')).toHaveCount(0);
    } finally {
      await users.close();
    }
  });
});
