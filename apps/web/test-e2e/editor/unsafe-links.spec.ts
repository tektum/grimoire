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
      // The injected link is clicked here, in the same step, once the guard has had its turn (its observer runs before this continuation): had it stayed
      // a link, the click would run the script and set the flag.
      const result = await editor.evaluate(async (el) => {
        const bad = document.createElement('a');
        bad.setAttribute('href', 'javascript:window.__pwned = true');
        bad.textContent = 'bad link';
        el.firstElementChild!.append(bad);
        const changed = el.querySelector<HTMLElement>('a[href="https://example.com/a"]')!;
        changed.setAttribute('href', 'data:text/html,<script>window.__pwned = true</script>');
        await Promise.resolve();
        const state = { badHasHref: bad.hasAttribute('href'), changedHasHref: changed.getAttribute('href')?.startsWith('data:') ?? false };
        bad.click();
        changed.click();
        return { ...state, pwned: (window as unknown as { __pwned?: boolean }).__pwned ?? false };
      });
      expect(result).toEqual({ badHasHref: false, changedHasHref: false, pwned: false });
      await expect(editor.locator('a[href^="javascript:"], a[href^="data:"]')).toHaveCount(0);
    } finally {
      await users.close();
    }
  });
});
