import { expect, test, type Page } from '@playwright/test';
import { makePage } from '../editor/pages';
import { signInAs } from '../support/sign-in';
import { waitForSynced } from '../support/sync';
import { statusLine, withScriptedPage } from './support';

// The one polite live region (`role="status"`, `aria-live="polite"`) receives Saved, the connection-loss text and each refusal text, and the focus does not move.
// The focused element by its tag and class, not its text: the text of the editor changes as the person types.
const active = (page: Page): Promise<string> => page.evaluate(() => `${document.activeElement?.tagName ?? ''}.${document.activeElement?.className ?? ''}`);

test.describe('the live region', () => {
  test('is the only role=status / aria-live element of the page screen, polite', async ({ browser, baseURL }) => {
    await withScriptedPage(browser, baseURL, {}, async ({ page }) => {
      await expect(statusLine(page)).toBeVisible();
      expect(await page.locator('main [role="status"], main [aria-live]').count()).toBe(1);
      await expect(statusLine(page)).toHaveAttribute('aria-live', 'polite');
    });
  });

  // Needs the whole stack: the server acknowledges what is typed.
  test('receives Saving and Saved while the person types, and the focus stays in the editor', async ({ browser, baseURL }) => {
    const made = await makePage('# Live\n\nText.\n', { permission: 'read_write' });
    const context = await browser.newContext({ ...(baseURL === undefined ? {} : { baseURL }) });
    try {
      await signInAs(context, 'e2e-alice', 'member');
      const page = await context.newPage();
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
      expect(await page.evaluate(() => (window as unknown as { line: Element }).line === document.querySelector('p.page-status') && (window as unknown as { line: Element }).line.isConnected), 'the same live region node').toBe(true);
      expect(await active(page)).toBe(before);
    } finally {
      await context.close();
    }
  });

  test('receives the connection-loss text without the focus moving', async ({ browser, baseURL }) => {
    await withScriptedPage(browser, baseURL, {}, async ({ page, collab }) => {
      await expect.poll(() => collab.tokens.length).toBe(1);
      await page.locator('a.page-history-link').focus();
      const before = await active(page);
      await collab.stop();
      await page.clock.runFor(11_000);
      await expect(statusLine(page)).toHaveText('Offline: changes kept in this tab');
      expect(await active(page)).toBe(before);
    });
  });

  test('receives a refusal text without the focus moving', async ({ browser, baseURL }) => {
    await withScriptedPage(browser, baseURL, { onAuth: { deny: 'page-full' } }, async ({ page }) => {
      await page.locator('a.page-history-link').focus();
      const before = await active(page);
      await expect(statusLine(page)).toHaveText('This page already has 100 people editing. Try again in a moment.');
      expect(await active(page)).toBe(before);
    });
  });
});
