import { expect, test } from '@playwright/test';
import { apiUrl } from '../support/env';
import { makePage } from '../editor/pages';
import { waitForSynced } from '../support/sync';
import { twoUsers } from '../support/two-users';
import { fits, measure, record, shot, stable } from './audit';

// The surfaces of the live editor on a phone (the slash menu and the selection bubble) need a document that really syncs: the stand-ins of the rest of the audit
// only speak the handshake. So this one file runs against the stack, like the other stack specs, and skips when no stack answers (the API's health check is the
// test): in the `e2e-web` job it runs, and a stack that is down is not reported as a phone failure.
const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 320, height: 568 },
] as const;

for (const viewport of VIEWPORTS) {
  test.describe(`at ${String(viewport.width)} by ${String(viewport.height)}`, () => {
    test.use({ viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
    test.beforeEach(({ browserName }) => { test.skip(browserName !== 'chromium', 'the phone audit runs in Chromium'); });
    // Decided before the test builds its page: a stack is up (the API answers its health check), or this file has nothing to look at.
    test.beforeEach(async () => {
      const up = await fetch(`${apiUrl()}/healthz`).then((r) => r.ok, () => false);
      test.skip(!up, `needs the stack's API at ${apiUrl()} (its collaboration server serves the synced document)`);
    });

    test('the slash menu and the selection bubble fit the phone', async ({ browser, baseURL }) => {
      const made = await makePage('Some words to select on a phone.\n');
      // `twoUsers` makes its own contexts: they are given the phone's, so `pointer: coarse` holds there too (the fixtures' `test.use` does not reach them).
      const users = await twoUsers(browser, baseURL, { context: { viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 1 } });
      try {
        const { page } = users.a;
        await page.setViewportSize(viewport);
        await page.goto(made.path);
        await waitForSynced(page);
        const surface = page.getByTestId('editor-root').locator('.ProseMirror');
        await surface.click();
        await page.keyboard.press('Control+End');
        await page.keyboard.press('Enter');
        await page.keyboard.type('/');
        await expect(page.getByRole('option').first()).toBeVisible();
        await stable(page, '[role=listbox]');
        const out: Record<string, unknown> = {};
        // The menu never runs past the bottom of the screen, and scrolls inside itself when the kinds do not fit.
        // `.slash-host` is the box with the cap (`max-height: min(20rem, --slash-room)`) and the scrolling: the listbox is its full-height child (`menus.css`).
        const menu = page.locator('.slash-host');
        const box = (await menu.boundingBox())!;
        expect(box.y + box.height, 'the menu ends inside the screen').toBeLessThanOrEqual(viewport.height + 0.5);
        expect(await menu.evaluate((h) => getComputedStyle(h).overflowY), 'the capped box scrolls inside').toMatch(/auto|scroll/);
        out['slash'] = { box, m: await measure(page, '[role=listbox]') };
        await shot(page, 'surface-slash-menu', { fullPage: false });
        await page.keyboard.press('Escape');
        await page.keyboard.press('Backspace');
        // A word selected with a double click brings the bubble (a key selection alone does not: the bar is for a selection the person made, and `Control+a`
        // goes to the browser's own select-all in this build), below the line and inside the screen.
        await surface.locator('p').first().dblclick();
        const bubble = page.getByRole('toolbar', { name: 'Text formatting' });
        await expect(bubble).toBeVisible();
        await stable(page, '[role=toolbar][aria-label="Text formatting"]');
        const fit = await fits(page, '[role=toolbar][aria-label="Text formatting"]');
        expect(fit.fitsWidth, 'the bubble is inside the screen').toBe(true);
        out['bubble'] = { fit, m: await measure(page, '[role=toolbar][aria-label="Text formatting"]') };
        await shot(page, 'surface-selection-bubble', { fullPage: false });
        record(`${String(viewport.width)}-surfaces-editor`, out);
      } finally {
        await users.close();
      }
    });
  });
}
