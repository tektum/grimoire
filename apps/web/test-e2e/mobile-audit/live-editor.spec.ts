import { expect, test } from '@playwright/test';
import { makePage } from '../editor/pages';
import { waitForSynced } from '../support/sync';
import { twoUsers } from '../support/two-users';
import { fits, measure, record, shot, stable } from './audit';

// The surfaces of the live editor on a phone (the slash menu and the selection bubble) need a document that really syncs: the stand-ins of the rest of the audit
// only speak the handshake. So this one file runs against the stack, like the other stack specs, in the Chromium job that starts it.
const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 320, height: 568 },
] as const;

for (const viewport of VIEWPORTS) {
  test.describe(`at ${String(viewport.width)} by ${String(viewport.height)}`, () => {
    test.use({ viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });

    test('the slash menu and the selection bubble fit the phone', async ({ browser, baseURL }) => {
      const made = await makePage('Some words to select on a phone.\n');
      const users = await twoUsers(browser, baseURL);
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
        const list = page.locator('[role=listbox]');
        const box = (await list.boundingBox())!;
        expect(box.y + box.height, 'the menu ends inside the screen').toBeLessThanOrEqual(viewport.height + 0.5);
        expect(await list.evaluate((l) => l.scrollHeight > l.clientHeight + 1 ? getComputedStyle(l.closest('.slash-host')!).overflowY : 'auto'), 'a menu taller than its room scrolls inside').toMatch(/auto|scroll/);
        out['slash'] = { box, m: await measure(page, '[role=listbox]') };
        await shot(page, 'surface-slash-menu', { fullPage: false });
        await page.keyboard.press('Escape');
        await page.keyboard.press('Backspace');
        // A selection made with the keys brings the bubble, below the line and inside the screen.
        await surface.locator('p').first().click();
        await page.keyboard.press('Control+a');
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
