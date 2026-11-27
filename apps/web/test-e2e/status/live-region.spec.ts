import { expect, test, type Page } from '@playwright/test';
import { makePage } from '../editor/pages';
import { signInAs } from '../support/sign-in';
import { waitForSynced } from '../support/sync';
import { slowServer, statusLine, withScriptedPage } from './support';

// The one polite live region (`role="status"`, `aria-live="polite"`) receives Saved, the connection-loss text and each refusal text, and the focus does not move.
// The focused element by its tag and class, not its text: the text of the editor changes as the person types.
const active = (page: Page): Promise<string> => page.evaluate(() => `${document.activeElement?.tagName ?? ''}.${document.activeElement?.className ?? ''}`);

test.describe('the live region', () => {
  // DESIGN.md (Accessibility rules): one polite live region for the save status and one for presence changes. The status sits in the top bar, the presence region in the page
  // (once the live editor is up, so not on this scripted server that never completes the sync); nothing else of the page screen is live (the toast area of the library is not part of it).
  test('has the save status in the top bar as its one polite live region, and in the page only the presence announcer', async ({ browser, baseURL }) => {
    await withScriptedPage(browser, baseURL, {}, async ({ page }) => {
      await expect(statusLine(page)).toBeVisible();
      expect(await page.locator('.shell-header [role="status"], .shell-header [aria-live]').count()).toBe(1);
      await expect(page.locator('.shell-header').locator(statusLine(page))).toHaveAttribute('aria-live', 'polite');
      expect(await page.locator('main [role="status"]:not(.presence-announcer), main [aria-live]:not(.presence-announcer)').count()).toBe(0);
      for (const announcer of await page.locator('main .presence-announcer').all()) await expect(announcer).toHaveAttribute('aria-live', 'polite');
    });
  });

  // Needs the whole stack: the server acknowledges what is typed.
  test('receives Saving and Saved while the person types, and the focus stays in the editor', async ({ browser, baseURL }) => {
    const made = await makePage('# Live\n\nText.\n', { permission: 'read_write' });
    const context = await browser.newContext({ ...(baseURL === undefined ? {} : { baseURL }) });
    try {
      await signInAs(context, 'e2e-alice', 'member');
      const page = await context.newPage();
      await slowServer(page); // "Saving" shows only when a save takes longer than 400ms
      await page.goto(made.path);
      await waitForSynced(page);
      await expect(statusLine(page)).toHaveText('Saved'); // nothing is waiting: what follows is the typing's
      await page.evaluate(() => {
        // The live region node is kept: screen readers announce changes inside a node that stays in the page. It is noted now and watched; it must be the same node after.
        const line = document.querySelector('p.page-status');
        if (line === null) throw new Error('no status line');
        const w = window as unknown as { line: Element; seen: string[] };
        w.line = line;
        w.seen = [];
        new MutationObserver(() => w.seen.push(line.textContent ?? '')).observe(line, { childList: true, characterData: true, subtree: true });
      });
      await page.locator('.ProseMirror').click();
      await page.keyboard.press('Control+End');
      const before = await active(page);
      await page.keyboard.type(' More.');
      await expect(statusLine(page)).toHaveText('Saving', { timeout: 1000 }); // held for a moment, however fast the server answers
      await expect(statusLine(page)).toHaveText('Saved', { timeout: 15_000 });
      const seen = await page.evaluate(() => (window as unknown as { seen: string[] }).seen);
      const saving = seen.indexOf('Saving');
      expect(saving, 'Saving was received').toBeGreaterThanOrEqual(0);
      expect(seen.indexOf('Saved', saving + 1), 'Saved came after Saving').toBeGreaterThan(saving);
      expect(
        await page.evaluate(() => (window as unknown as { line: Element }).line === document.querySelector('p.page-status') && (window as unknown as { line: Element }).line.isConnected),
        'the same live region node',
      ).toBe(true);
      expect(await active(page)).toBe(before);
    } finally {
      await context.close();
    }
  });

  test('receives the connection-loss text without the focus moving', async ({ browser, baseURL }) => {
    await withScriptedPage(browser, baseURL, {}, async ({ page, collab }) => {
      await expect.poll(() => collab.tokens.length).toBe(1);
      await page.getByRole('button', { name: 'More page actions' }).focus();
      const before = await active(page);
      await collab.stop();
      // The page's clock is the test's: the offline text comes 10 s after an attempt has failed, and the failed attempt arrives in real time (a browser that takes longer to refuse the connection, WebKit,
      // delivers it after a single `runFor` has run, and the timer is then armed on a clock that nobody advances). So the clock is advanced a second at a time until the text is there.
      await expect
        .poll(
          async () => {
            await page.clock.runFor(1_000);
            return statusLine(page).textContent();
          },
          { timeout: 20_000, intervals: [100], message: 'the connection-loss text, with the clock advanced a second at a time' },
        )
        .toBe('Offline: changes kept in this tab');
      expect(await active(page)).toBe(before);
    });
  });

  test('receives a refusal text without the focus moving', async ({ browser, baseURL }) => {
    await withScriptedPage(browser, baseURL, { onAuth: { deny: 'page-full' } }, async ({ page }) => {
      await page.getByRole('button', { name: 'More page actions' }).focus();
      const before = await active(page);
      await expect(statusLine(page)).toHaveText('This page already has 100 people editing. Try again in a moment.');
      expect(await active(page)).toBe(before);
    });
  });
});
