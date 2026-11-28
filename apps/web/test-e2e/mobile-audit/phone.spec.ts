import { expect, test, type Page } from '@playwright/test';
import { open, VISITS } from './world';

// The phone promises this suite owns as assertions, against the stand-ins (mockApi and historyApi answer the requests; no stack and no collaboration server
// is involved). They are the two the design review asked for: the page never pans sideways on a phone, and the access table keeps its Remove control on screen.
const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 320, height: 568 },
] as const;

/** How far the document is wider than the screen: 0 when it never pans sideways (WCAG 1.4.10). */
const sideways = (page: Page): Promise<number> =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test.describe('a phone', () => {
  // A phone's pointer is a finger (`pointer: coarse`), which is what the phone layout and the 44px rules hang on.
  test.use({ hasTouch: true, isMobile: true, deviceScaleFactor: 1 });

  for (const viewport of VIEWPORTS) {
    for (const slug of ['page', 'revision'] as const) {
      test(`${slug} at ${String(viewport.width)}: the page never pans sideways`, async ({ page, context }) => {
        await page.setViewportSize(viewport);
        await open(page, context, VISITS.find((v) => v.slug === slug)!);
        expect(await sideways(page), `${slug} is ${String(await sideways(page))}px wider than ${String(viewport.width)}`).toBe(0);
      });
    }

    test(`the access table at ${String(viewport.width)}: every Remove control is inside the screen`, async ({ page, context }) => {
      await page.setViewportSize(viewport);
      await open(page, context, VISITS.find((v) => v.slug === 'admin-access')!);
      const view = page.viewportSize()!;
      const removes = page.getByRole('table', { name: 'Who has access' }).getByRole('button', { name: /^Remove / });
      await expect(removes.first()).toBeVisible();
      for (const box of await removes.evaluateAll((buttons) => buttons.map((b) => b.getBoundingClientRect().toJSON() as { left: number; right: number }))) {
        expect(box.left, 'a Remove control starts inside the screen').toBeGreaterThanOrEqual(-0.5);
        expect(box.right, 'a Remove control ends inside the screen').toBeLessThanOrEqual(view.width + 0.5);
      }
    });
  }
});
