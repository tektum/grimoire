import { expect, test } from '@playwright/test';
import { waitForSynced } from '../support/sync';
import { twoUsers } from '../support/two-users';
import { makePage, readMarkdown, readPage, removePageForGood, resetPageState } from './pages';
import { compose, psqlAdmin, waitReady } from './stack';

test.describe('a server that was restored', () => {
  test("a tab that holds a higher epoch than the restored server is refused, reloads the server's page once, and writes nothing of its own content", async ({ browser, baseURL }) => {
    test.slow();
    const made = await makePage('# Restored\n\nThe saved text.\n');
    await resetPageState(made.id, { confirmStale: true }); // the epoch is now above its first value
    const users = await twoUsers(browser, baseURL);
    try {
      const { page } = users.a;
      await page.goto(made.path);
      await waitForSynced(page);
      const before = await readPage(made.id);
      expect(before.stateEpoch).toBeGreaterThan(0);
      const markdownBefore = await readMarkdown(made.id);

      // The database is restored from an older copy: the page is back at a lower epoch than the tab's.
      await compose('stop', 'app');
      await psqlAdmin(`update pages set state_epoch = ${before.stateEpoch - 1} where id = '${made.id}'`);
      await compose('start', 'app');
      await waitReady();

      // The tab is refused with a stale epoch and reopens the page: one editor, the server's text, and a server whose text did not change.
      await expect(page.getByTestId('editor-root')).toHaveAttribute('data-collab-state', 'synced', { timeout: 120_000 });
      await expect(page.locator('.ProseMirror')).toHaveCount(1);
      await expect(page.locator('.ProseMirror')).toContainText('The saved text.');
      expect((await readPage(made.id)).stateEpoch).toBe(before.stateEpoch - 1);
      expect(await readMarkdown(made.id)).toBe(markdownBefore);
    } finally {
      await users.close();
    }
  });

  test('a tab whose page no longer exists shows the not-found screen, and writes nothing', async ({ browser, baseURL }) => {
    test.slow();
    const made = await makePage('# Gone\n\nSoon gone.\n');
    const users = await twoUsers(browser, baseURL);
    try {
      const { page } = users.a;
      await page.goto(made.path);
      await waitForSynced(page);
      await page.locator('.ProseMirror p', { hasText: 'Soon gone.' }).click();
      await page.keyboard.press('End');
      await page.keyboard.type(' Typed before it went.');

      await removePageForGood(made.id);

      await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible({ timeout: 120_000 });
      await expect(page.getByTestId('editor-root')).toHaveCount(0);
      const response = await fetch(`${new URL('/v1/pages/' + made.id, process.env['E2E_API_URL'] ?? 'http://127.0.0.1:8080')}`);
      expect([401, 403, 404]).toContain(response.status); // nothing was written back to bring it to life
    } finally {
      await users.close();
    }
  });
});
