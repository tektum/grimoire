import { expect, test } from '@playwright/test';
import { measure, record } from './audit';
import { open, VISITS } from './world';

// DESIGN.md, and WCAG 1.4.10: an overlay must not change the page's width. The dialog library locks the scroll by adding a margin where it thinks a scrollbar is;
// on a phone whose page is exactly the screen wide, that margin is what used to collapse the layout (a 76px band the page did not have). Here it is asserted:
// opening the palette changes neither the document's overflow nor the width of `main`, and the overlay sits inside the screen.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });

test('the palette does not reflow the page at 390', async ({ page, context }) => {
  await open(page, context, VISITS.find((v) => v.slug === 'page')!);
  const before = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, main: Math.round(document.querySelector('main')!.getBoundingClientRect().width) }));
  await page.getByRole('button', { name: 'Show contents', exact: true }).click();
  await page.locator('.contents-search').click();
  await expect(page.locator('.modal.palette')).toBeVisible();
  const after = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    main: Math.round(document.querySelector('main')!.getBoundingClientRect().width),
    lockMargin: getComputedStyle(document.body).marginRight,
    paletteInside: (() => { const r = document.querySelector('.modal.palette')!.getBoundingClientRect(); return r.left >= -0.5 && r.right <= document.documentElement.clientWidth + 0.5; })(),
  }));
  record('390-scroll-lock', { before, after });
  expect(after.overflow, 'the palette adds no sideways overflow').toBe(before.overflow);
  expect(after.main, 'the page keeps its width under the palette').toBe(before.main);
  expect(after.lockMargin, 'no margin stands in for a scrollbar the phone does not have').toBe('0px');
  expect(after.paletteInside, 'the palette is inside the screen').toBe(true);
  expect((await measure(page)).overflowPx, 'nothing overflows with the palette open').toBe(0);
});
