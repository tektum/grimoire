import { expect, test } from '@playwright/test';
import { waitForSynced } from '../support/sync';
import { twoUsers } from '../support/two-users';
import { makePage } from './pages';

test.describe('links in the page text', () => {
  test('a safe address stays a link and an unsafe one never is, in the read-only first view and in the live editor', async ({ browser, baseURL }) => {
    const made = await makePage('# Links\n\nSee [the site](https://example.com/a) and [mail](mailto:ada@example.com) and [here](/p/other-ab12cd).\n');
    const users = await twoUsers(browser, baseURL);
    try {
      const { page } = users.a;
      await page.goto(made.path);
      await waitForSynced(page);
      const editor = page.locator('.ProseMirror');
      await expect(editor.locator('a[href="https://example.com/a"]')).toHaveCount(1);
      await expect(editor.locator('a[href="mailto:ada@example.com"]')).toHaveCount(1);
      await expect(editor.locator('a[href="/p/other-ab12cd"]')).toHaveCount(1);

      // An unsafe address that reaches the page by any other way than the saved text (another person's edit, a change of the attribute) is not a link either.
      await editor.evaluate((el) => {
        const bad = document.createElement('a');
        bad.setAttribute('href', 'javascript:window.__pwned = true');
        bad.textContent = 'bad link';
        el.firstElementChild!.append(bad);
        const existing = el.querySelector('a[href="https://example.com/a"]')!;
        existing.setAttribute('href', 'data:text/html,<script>window.__pwned = true</script>');
      });
      await expect(editor.locator('a[href^="javascript:"], a[href^="data:"]')).toHaveCount(0);
      // The editor may put its own DOM back or leave the guarded link as text: either way nothing can be followed.
      await editor
        .getByText('bad link')
        .click({ trial: true })
        .catch(() => undefined);
      await page.evaluate(() => document.querySelectorAll('a[data-unsafe-link]').forEach((a) => (a as HTMLElement).click()));
      expect(await page.evaluate(() => (window as unknown as { __pwned?: boolean }).__pwned)).toBeUndefined();
    } finally {
      await users.close();
    }
  });
});
