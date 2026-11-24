import { expect, test, type Page } from '@playwright/test';
import { makePage } from '../editor/pages';
import { signInAs } from '../support/sign-in';
import { waitForSynced } from '../support/sync';
import { statusLine, withScriptedPage } from './support';

// The one polite live region (`role="status"`, `aria-live="polite"`) receives Saved, the connection-loss text and each refusal text, and the focus does not move.
const active = (page: Page): Promise<string> => page.evaluate(() => `${document.activeElement?.tagName ?? ''}.${document.activeElement?.className ?? ''}.${document.activeElement?.textContent?.slice(0, 20) ?? ''}`);

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
      await page.evaluate(() => {
        // The whole body is watched, and the line looked up each time: the line may be a new element after a render.
        const seen: string[] = [];
        (window as unknown as { seen: string[] }).seen = seen;
        const note = () => {
          const text = document.querySelector('p.page-status')?.textContent ?? '';
          if (seen[seen.length - 1] !== text) seen.push(text);
        };
        new MutationObserver(note).observe(document.body, { childList: true, characterData: true, subtree: true });
      });
      await page.locator('.ProseMirror').click();
      await page.keyboard.press('Control+End');
      const before = await active(page);
      await page.keyboard.type(' More.');
      await expect(statusLine(page)).toHaveText('Saved', { timeout: 15_000 });
      const seen = await page.evaluate(() => (window as unknown as { seen: string[] }).seen);
      expect(seen).toContain('Saving');
      expect(seen).toContain('Saved');
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
