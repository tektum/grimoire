import { expect, test, type Page } from '@playwright/test';
import { COLLAB_COLOURS, colourIndex, contrast } from '../../src/ui/collab';
import { signInAs } from '../support/sign-in';
import { waitForSynced } from '../support/sync';
import { twoUsers } from '../support/two-users';
import { makePage, whoIs } from './pages';

const FILLER = Array.from({ length: 40 }, (_, i) => `Filler paragraph number ${i + 1}, to make the page longer than the window.`).join('\n\n');
const PARAGRAPH = 'The shared paragraph.';

const caretAt = async (page: Page, text: string, where: 'End' | 'Home'): Promise<void> => {
  await page.locator('.ProseMirror p', { hasText: text }).first().click();
  await page.keyboard.press(where);
};
const toHex = (rgb: string): string => {
  const [r, g, b] = (rgb.match(/\d+/g) ?? []).map(Number);
  return `#${[r, g, b].map((n) => (n ?? 0).toString(16).padStart(2, '0')).join('')}`;
};

test.describe('remote cursors', () => {
  test("are always visible: the caret and selection in the person's colour with the directory name, the label for 3 s after each move, readable on both themes, through a scroll and a reconnect", async ({
    browser,
    baseURL,
  }) => {
    test.slow();
    const made = await makePage(`# Cursors\n\n${PARAGRAPH}\n\n${FILLER}\n`);
    const users = await twoUsers(browser, baseURL);
    try {
      const [a, b] = [users.a, users.b];
      const meB = await whoIs(b.userId);
      for (const who of [a, b]) {
        await who.page.goto(made.path);
        await waitForSynced(who.page);
      }
      const cursor = a.page.locator('.ProseMirror-yjs-cursor');
      const label = cursor.locator('.cursor-label');

      // The label is shown when the cursor arrives, and hides after 3 s.
      await caretAt(b.page, PARAGRAPH, 'End');
      await expect(label).toHaveText(meB.name);
      await expect(label).toHaveClass(/cursor-label--shown/);
      await expect(label).not.toHaveClass(/cursor-label--shown/, { timeout: 8000 });
      await expect(label).toHaveCSS('opacity', '0');

      // It shows again for 3 s after each move, and the caret is at least 2 px wide, in the colour of the id.
      await b.page.keyboard.press('ArrowLeft');
      await expect(label).toHaveClass(/cursor-label--shown/);
      const width = await cursor.evaluate((el) => Number.parseFloat(getComputedStyle(el).borderInlineStartWidth));
      expect(width).toBeGreaterThanOrEqual(2);
      expect(await cursor.evaluate((el) => (el as HTMLElement).style.getPropertyValue('--cursor'))).toBe(COLLAB_COLOURS[colourIndex(meB.id)]);

      // A selection is drawn with a tint of the colour.
      for (let i = 0; i < 5; i++) await b.page.keyboard.press('Shift+ArrowLeft');
      const selection = a.page.locator('.ProseMirror-yjs-selection').first();
      await expect(selection).toBeVisible();
      expect(await selection.evaluate((el) => getComputedStyle(el).backgroundColor)).toMatch(/^rgba\(.+, 0?\.\d+\)$/);

      // The caret reads against the page on both themes: at least 3:1 for every colour of the palette.
      for (const scheme of ['light', 'dark'] as const) {
        await a.page.emulateMedia({ colorScheme: scheme });
        const background = toHex(await a.page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor));
        for (const colour of COLLAB_COLOURS) expect(contrast(colour, background), `${colour} on ${background} (${scheme})`).toBeGreaterThanOrEqual(3);
      }

      // The cursor survives a scroll of A's page ...
      await a.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await a.page.evaluate(() => window.scrollTo(0, 0));
      await expect(cursor).toHaveCount(1);

      // ... and a reconnect of B.
      await b.context.setOffline(true);
      await b.context.setOffline(false);
      await waitForSynced(b.page);
      await b.page.keyboard.press('ArrowRight');
      await expect(cursor).toHaveCount(1, { timeout: 60_000 });
      await expect(label).toHaveText(meB.name);
    } finally {
      await users.close();
    }
  });

  test('two cursors on the same character are both visible and distinguishable: both labels shown, offset so neither covers the other', async ({ browser, baseURL }) => {
    const made = await makePage(`# Same place\n\n${PARAGRAPH}\n`);
    const users = await twoUsers(browser, baseURL);
    const third = await browser.newContext({ ...(baseURL === undefined ? {} : { baseURL }), viewport: { width: 1280, height: 800 } });
    try {
      await signInAs(third, 'e2e-carol', 'member');
      const carol = await third.newPage();
      const [meB, meC] = await Promise.all([whoIs(users.b.userId), whoIs('e2e-carol')]);
      for (const page of [users.a.page, users.b.page, carol]) {
        await page.goto(made.path);
        await waitForSynced(page);
      }
      await caretAt(users.b.page, PARAGRAPH, 'End');
      await caretAt(carol, PARAGRAPH, 'End');

      const cursors = users.a.page.locator('.ProseMirror-yjs-cursor');
      await expect(cursors).toHaveCount(2);
      const labels = cursors.locator('.cursor-label');
      await expect(labels).toHaveCount(2);
      await expect(labels.first()).toHaveClass(/cursor-label--shown/);
      await expect(labels.nth(1)).toHaveClass(/cursor-label--shown/);
      expect((await labels.allTextContents()).sort()).toEqual([meB.name, meC.name].sort());
      if (colourIndex(meB.id) !== colourIndex(meC.id)) {
        const colours = await cursors.evaluateAll((els) => els.map((el) => (el as HTMLElement).style.getPropertyValue('--cursor')));
        expect(new Set(colours).size).toBe(2); // different colours, as their ids hash apart
      }
      // The carets themselves stand apart too: neither hides the other.
      const lefts = await cursors.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().left));
      expect(Math.abs(lefts[0]! - lefts[1]!)).toBeGreaterThanOrEqual(2);
      // The labels are offset: their boxes do not overlap.
      const [first, second] = await labels.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON() as DOMRect));
      const overlap = first!.left < second!.right && second!.left < first!.right && first!.top < second!.bottom && second!.top < first!.bottom;
      expect(overlap).toBe(false);
    } finally {
      await third.close();
      await users.close();
    }
  });
});
