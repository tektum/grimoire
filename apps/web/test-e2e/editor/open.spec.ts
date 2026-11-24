import { expect, test } from '@playwright/test';
import { waitForSynced } from '../support/sync';
import { twoUsers } from '../support/two-users';
import { makePage } from './pages';

test.describe('opening a page', () => {
  test('the saved text shows read-only first and the live editor takes its place once the page has synced, with exactly one editor', async ({ browser, baseURL }) => {
    const made = await makePage('# Opening\n\nThe saved text.\n');
    const users = await twoUsers(browser, baseURL);
    try {
      const { page } = users.a;
      await page.goto(made.path);
      const root = page.getByTestId('editor-root');
      await expect(root).toContainText('The saved text.');
      await waitForSynced(page);
      await expect(root).toHaveAttribute('data-collab-state', 'synced');
      await expect(page.locator('.ProseMirror')).toHaveCount(1);
      await expect(page.locator('.ProseMirror')).toHaveAttribute('contenteditable', 'true');
      await expect(root).toContainText('The saved text.');
    } finally {
      await users.close();
    }
  });

  test('leaving the page and coming back mounts exactly one editor again: the one that was left is gone', async ({ browser, baseURL }) => {
    const made = await makePage('# Again\n\nOne editor at a time.\n');
    const users = await twoUsers(browser, baseURL);
    try {
      const { page } = users.a;
      await page.goto(made.path);
      await waitForSynced(page);
      await expect(page.locator('.ProseMirror')).toHaveCount(1);
      await page.getByRole('link', { name: 'Search' }).click(); // the page screen unmounts
      await expect(page.getByTestId('editor-root')).toHaveCount(0);
      await expect(page.locator('.ProseMirror')).toHaveCount(0);
      await page.goBack(); // and mounts again
      await waitForSynced(page);
      await expect(page.locator('.ProseMirror')).toHaveCount(1);
      await expect(page.locator('.ProseMirror')).toContainText('One editor at a time.');
    } finally {
      await users.close();
    }
  });

  test("what one person types is in the other's editor, without a reload", async ({ browser, baseURL }) => {
    const made = await makePage('# Together\n\nStart.\n');
    const users = await twoUsers(browser, baseURL);
    try {
      for (const who of [users.a, users.b]) {
        await who.page.goto(made.path);
        await waitForSynced(who.page);
      }
      await users.a.page.locator('.ProseMirror').click();
      await users.a.page.keyboard.press('Control+End');
      await users.a.page.keyboard.type(' Added by the first.');
      await expect(users.b.page.locator('.ProseMirror')).toContainText('Added by the first.');
    } finally {
      await users.close();
    }
  });

  test('a reader sees the Read only label and cannot type', async ({ browser, baseURL }) => {
    const made = await makePage('# Reading\n\nNo typing.\n', { permission: 'read' });
    const users = await twoUsers(browser, baseURL);
    try {
      const { page } = users.b;
      await page.goto(made.path);
      await waitForSynced(page);
      await expect(page.getByText('Read only', { exact: true })).toBeVisible();
      await expect(page.locator('.ProseMirror')).toHaveAttribute('contenteditable', 'false');
    } finally {
      await users.close();
    }
  });

  test('a page that does not exist says so', async ({ browser, baseURL }) => {
    const users = await twoUsers(browser, baseURL);
    try {
      await users.a.page.goto('/p/page-doesnotexist');
      await expect(users.a.page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
    } finally {
      await users.close();
    }
  });
});
