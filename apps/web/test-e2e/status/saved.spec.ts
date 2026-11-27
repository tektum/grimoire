import { expect, test } from '@playwright/test';
import { makePage } from '../editor/pages';
import { signInAs } from '../support/sign-in';
import { waitForSynced } from '../support/sync';
import { slowServer, statusLine, withScriptedPage } from './support';

test.describe('the status line: Saved, Saving and Offline', () => {
  // Needs the whole stack: the server acknowledges what is typed.
  test('Saving appears within 1 s of a keystroke, and Saved after the server has acknowledged it', async ({ browser, baseURL }) => {
    const made = await makePage('# Status\n\nText.\n', { permission: 'read_write' });
    const context = await browser.newContext({ ...(baseURL === undefined ? {} : { baseURL }) });
    try {
      await signInAs(context, 'e2e-alice', 'member');
      const page = await context.newPage();
      await slowServer(page); // "Saving" shows only when a save takes longer than 400ms
      await page.goto(made.path);
      await waitForSynced(page);
      await expect(statusLine(page)).toHaveText('Saved');
      await page.locator('.ProseMirror').click();
      await page.keyboard.press('Control+End');
      await page.keyboard.type(' More.');
      await expect(statusLine(page)).toHaveText('Saving', { timeout: 1000 });
      await expect(statusLine(page)).toHaveText('Saved', { timeout: 15_000 });
    } finally {
      await context.close();
    }
  });

  // On a scripted collaboration server: the connection is lost and the server stays away.
  test('with the server stopped, the line reads "Offline: changes kept in this tab" once it has been unreachable for 10 s, not before', async ({ browser, baseURL }) => {
    await withScriptedPage(browser, baseURL, {}, async ({ page, collab }) => {
      await expect.poll(() => collab.tokens.length).toBe(1);
      await collab.stop();
      await page.clock.runFor(9_000);
      await expect(statusLine(page)).not.toHaveText('Offline: changes kept in this tab');
      await page.clock.runFor(2_000);
      await expect(statusLine(page)).toHaveText('Offline: changes kept in this tab');
    });
  });
});
