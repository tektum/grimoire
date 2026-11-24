import { readFileSync } from 'node:fs';
import { buildDevToken } from '../../test/support/dev-token';
import { expect, test } from '@playwright/test';
import { apiUrl, devSecret } from '../support/env';
import { waitForSynced } from '../support/sync';
import { twoUsers } from '../support/two-users';
import { controlNetwork } from './network';
import { makePage, resetPageState } from './pages';

test.describe('the epoch handshake', () => {
  test('a tab that was offline across a reset is not allowed to push its old edits: it reloads the reset page once and keeps a copy of what it had', async ({ browser, baseURL }) => {
    test.slow(); // a minute or more of reconnecting, and a reset, in one test
    const made = await makePage('# Epoch\n\nold\n', { title: 'Epoch page' });
    const users = await twoUsers(browser, baseURL);
    try {
      const { page } = users.a;
      const network = await controlNetwork(page);
      await page.goto(made.path);
      await waitForSynced(page);
      await page.locator('.ProseMirror p', { hasText: 'old' }).click();
      await page.keyboard.press('End');
      await page.keyboard.type(' old-edit');
      await expect(page.locator('.ProseMirror')).toContainText('old-edit');

      await network.cut();
      await page.keyboard.type(' more');
      await resetPageState(made.id, { confirmStale: true, markdown: '# Epoch\n\nnew\n' });
      await network.restore();

      // The tab shows the reset page, once, and says what happened.
      const notice = page.getByRole('alert').filter({ hasText: 'This page was reset. Your unsent changes were not applied.' });
      await expect(notice).toBeVisible({ timeout: 60_000 });
      await expect(notice.getByRole('button')).toHaveText(['Download my copy', 'Copy to clipboard', 'Dismiss']);
      await waitForSynced(page);
      await expect(page.locator('.ProseMirror')).toHaveCount(1);
      await expect(page.locator('.ProseMirror')).toContainText('new');
      await expect(page.locator('.ProseMirror')).not.toContainText('old');

      // The copy is Markdown with the edits the tab held.
      const download = page.waitForEvent('download');
      await notice.getByRole('button', { name: 'Download my copy' }).click();
      const file = await download;
      expect(file.suggestedFilename()).toBe('Epoch page-your-copy.md');
      const copy = readFileSync((await file.path())!, 'utf8');
      expect(copy).toContain('old-edit'); // typed while online, saved before the cut
      expect(copy).toContain('more'); // typed after the cut: never reached the server, only the copy has it

      // The saved page, read by anyone, is the reset one and has none of the old edits.
      const response = await fetch(`${apiUrl()}/v1/pages/${made.id}/markdown`, { headers: { Authorization: `Bearer ${buildDevToken(devSecret(), users.b.userId, 'member')}` } });
      const saved = await response.text();
      expect(saved).toContain('new');
      expect(saved).not.toContain('old');
    } finally {
      await users.close();
    }
  });
});
