import { expect, test } from '@playwright/test';
import { makePage } from '../editor/pages';
import { signInAs } from '../support/sign-in';
import { waitForSynced } from '../support/sync';
import { twoUsers } from '../support/two-users';
import { LIMIT_TEXT, blocks, remoteBlocks, surface } from './support';

/** What the text must carry (the acceptance): the three actions, the deferral, and the separate sentence on mixed letters. */
function expectCarries(text: string): void {
  expect(text).toBe(LIMIT_TEXT);
  for (const action of ['splitting it', 'joining it with the one above', 'turning it into a list']) expect(text, action).toContain(action);
  expect(text).toContain('Holding back Enter, Backspace and list changes while someone else is in the paragraph, and offering to keep a copy automatically, are planned after the first version.'); // deferred (decision 147)
  expect(text).toContain('Separately, if two people type several letters at exactly the same spot at the same moment, their letters can end up mixed together');
}

test.describe('the limits of editing together, in words', () => {
  test('are on the "Why?" of the lock message and on the help page, in their exact words', async ({ browser, baseURL }) => {
    test.slow();
    const made = await makePage('First paragraph.\n\nSecond paragraph, where Bob is.\n');
    const users = await twoUsers(browser, baseURL);
    try {
      const [a, b] = [users.a.page, users.b.page];
      for (const page of [a, b]) {
        await page.goto(made.path);
        await waitForSynced(page);
      }
      const target = (await blocks(a))[1]!;
      await surface(b).locator('p', { hasText: 'Second paragraph' }).click();
      await expect.poll(async () => (await remoteBlocks(a)).map((r) => r.blockId), { timeout: 15_000 }).toContain(target.id);
      await surface(a).locator('p', { hasText: 'Second paragraph' }).hover();
      await a.getByRole('button', { name: 'Block menu' }).click();
      await a.getByRole('option', { name: /^Quote/ }).click();
      await a.getByRole('button', { name: 'Why?' }).click();
      expectCarries((await a.getByRole('alert').locator('.lock-help p').nth(1).textContent()) ?? '');

      // The same words on the help page.
      const context = await browser.newContext({ ...(baseURL === undefined ? {} : { baseURL }) });
      try {
        await signInAs(context, 'e2e-reader', 'member');
        const help = await context.newPage();
        await help.goto('/help');
        await expect(help.getByRole('heading', { name: 'Editing together' })).toBeVisible();
        expectCarries((await help.locator('.lock-help p').nth(1).textContent()) ?? '');
      } finally {
        await context.close();
      }
    } finally {
      await users.close();
    }
  });
});
