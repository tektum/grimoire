import { expect, test } from '@playwright/test';
import { expectNoAxeViolations } from '../support/axe';
import { shots } from '../support/shots';
import { waitForSynced } from '../support/sync';
import { twoUsers } from '../support/two-users';
import { makePage } from './pages';

const MARKDOWN = [
  '# Heading one',
  '',
  '## Heading two',
  '',
  '### Heading three',
  '',
  '#### Heading four',
  '',
  '##### Heading five',
  '',
  '###### Heading six',
  '',
  'Body text under the headings.',
  '',
].join('\n');

test.describe('the page text: first view and live editor', () => {
  test('both have a name for the editing surface and no accessibility violations, and the first view is set like the live one: same font, every heading level styled', async ({ browser, baseURL }) => {
    test.slow(); // the sync wait below may have to outlast a backoff
    const made = await makePage(MARKDOWN);
    const users = await twoUsers(browser, baseURL);
    try {
      const { page } = users.a;
      // The first view stays on screen while the connection cannot be made: only the sockets are refused, so the page and its saved text load as usual.
      let refuse = true;
      await page.routeWebSocket(/.*/, (socket) => (refuse ? void socket.close({ code: 4000, reason: 'held back by the spec' }) : void socket.connectToServer()));
      await page.goto(made.path);
      const surface = page.locator('.ProseMirror');
      await expect(surface.locator('h6')).toHaveText('Heading six');
      await expect(page.getByTestId('editor-root')).not.toHaveAttribute('data-collab-state', 'synced');
      await expect(surface).toHaveAttribute('aria-label', 'Page text');
      await expectNoAxeViolations(page);

      const look = () =>
        page.evaluate(() => {
          const style = (selector: string) => {
            const css = getComputedStyle(document.querySelector(selector)!);
            return { font: css.fontFamily, size: Number.parseFloat(css.fontSize), weight: Number(css.fontWeight) };
          };
          return { p: style('.ProseMirror p'), h1: style('.ProseMirror h1'), h3: style('.ProseMirror h3'), h4: style('.ProseMirror h4'), h5: style('.ProseMirror h5'), h6: style('.ProseMirror h6') };
        });
      const first = await look();
      await shots(page, 'm6-t04', 'page-text-first-view');

      refuse = false;
      // The page waits out a backoff of up to 30 s before its next attempt; the browser's own offline and online events make it connect at once.
      await page.context().setOffline(true);
      await page.context().setOffline(false);
      await waitForSynced(page, { timeout: 60_000 }); // room for a backoff already running (the test is marked slow for this)
      await expect(surface).toHaveAttribute('aria-label', 'Page text');
      await expectNoAxeViolations(page);
      const live = await look();
      expect(first, 'nothing jumps when the live editor replaces the first view').toEqual(live);

      expect(first.p.font).toContain('Georgia'); // the reading font, which only --font-page names
      expect(first.p.font).not.toContain('sans-serif'); // not the UI font
      for (const level of ['h3', 'h4', 'h5', 'h6'] as const) expect(first[level].weight, `${level} is bold`).toBeGreaterThanOrEqual(600);
      expect(first.h1.size).toBeGreaterThan(first.h3.size);
      expect(first.h3.size).toBeGreaterThan(first.p.size);
      expect(first.h6.size).toBeLessThan(first.p.size);
      await shots(page, 'm6-t04', 'page-text-live');
    } finally {
      await users.close();
    }
  });
});
