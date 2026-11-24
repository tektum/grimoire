import { expect, test } from '@playwright/test';
import { signInAs } from '../support/sign-in';
import { STOPS, stopReady } from './routes';
import { horizontalOverflow } from './support';
import { prepareWorld, type World } from './world';

// A page at 200% zoom on a 1280 pixel window is 640 CSS pixels wide, and at 400% it is 320: no route scrolls sideways at either (needs the whole stack).
test.describe.configure({ mode: 'serial' });
let world: World;

test.beforeAll(async ({ browser, baseURL }) => {
  test.slow(); // the stack side of the tour: collections, pages and a saved version
  world = await prepareWorld(browser, baseURL);
});

for (const [zoom, width, height] of [
  ['200%', 640, 400],
  ['400%', 320, 256],
] as const) {
  test(`at ${zoom} zoom (${width} CSS pixels wide) no route scrolls sideways`, async ({ browser, baseURL }) => {
    test.slow();
    const wide: string[] = [];
    for (const stop of STOPS) {
      const context = await browser.newContext({ ...(baseURL === undefined ? {} : { baseURL }), viewport: { width: 1280, height: 800 } });
      try {
        if (stop.who !== 'nobody') await signInAs(context, stop.who === 'admin' ? 'e2e-admin' : 'e2e-tourist', stop.who);
        const page = await context.newPage();
        await page.goto(stop.path(world));
        await stopReady(stop, page, world);
        await page.setViewportSize({ width, height });
        const over = await horizontalOverflow(page);
        if (over > 0) wide.push(`${stop.route}: ${over}px wider than the window`);
      } finally {
        await context.close();
      }
    }
    expect(wide, `routes that scroll sideways at ${zoom}`).toEqual([]);
  });
}

// 832 pixels is 52rem: up to it the table's narrow rules apply (the table scrolls sideways inside its own region where its columns do not fit). 656 is 41rem: just above the 40rem where
// the shell goes to one column, the contents (18rem) sit beside the page and the table has the least room of any width; 833 is just above the narrow rules.
for (const width of [320, 656, 700, 832, 833, 1280]) {
  test(`the access table, with its rows, at ${width} pixels: its controls are whole and inside their cells, the chosen label is not clipped, and only its own region scrolls`, async ({ browser, baseURL }) => {
    const context = await browser.newContext({ ...(baseURL === undefined ? {} : { baseURL }), viewport: { width, height: 700 } });
    try {
      await signInAs(context, 'e2e-admin', 'admin');
      const page = await context.newPage();
      await page.goto(`/admin/collections/${world.collectionId}/access`);
      const table = page.getByRole('table', { name: 'Who has access' });
      await expect(table.getByRole('row')).toHaveCount(3); // the header and the two entries of the world: a group with read and write chosen, and a person with read
      const region = page.getByRole('region', { name: 'Access list' });
      await expect(region, 'the region that scrolls is a stop of the Tab order').toHaveAttribute('tabindex', '0');
      const boxes = await table.locator('select, button').evaluateAll((controls) =>
        controls.map((c) => {
          let clipped = 0;
          if (c instanceof HTMLSelectElement) {
            // The width the select would have with room to spare (its widest choice whole), against the width it has: the chosen label is not cut.
            const clone = c.cloneNode(true) as HTMLSelectElement;
            clone.style.cssText = 'position:absolute;visibility:hidden;max-width:none;width:auto';
            c.parentElement!.append(clone);
            clipped = Math.round(clone.getBoundingClientRect().width - c.getBoundingClientRect().width);
            clone.remove();
          }
          return {
            label: c.getAttribute('aria-label') ?? '',
            chosen: c instanceof HTMLSelectElement ? (c.selectedOptions[0]?.textContent ?? '') : '',
            ...(c.getBoundingClientRect().toJSON() as { left: number; right: number; top: number; height: number }),
            cellRight: (c.closest('td') as HTMLElement).getBoundingClientRect().right,
            tag: c.tagName,
            fontSize: getComputedStyle(c).fontSize,
            clipped,
          };
        }),
      );
      expect(boxes.length).toBe(4);
      expect(boxes.map((b) => b.chosen).filter((c) => c !== '')).toEqual(['read and write', 'read']);
      for (const box of boxes) {
        expect(box.right, `${box.label} ends inside its own cell`).toBeLessThanOrEqual(box.cellRight);
        expect(box.height, `${box.label} is one line (its text is not broken up)`).toBeLessThanOrEqual(44);
        if (box.tag === 'SELECT') {
          expect(box.clipped, `${box.label} (${box.chosen}) is cut by ${box.clipped}px`).toBeLessThanOrEqual(1);
          if (width <= 832) expect(box.fontSize, `${box.label} has the smaller text of the narrow rules (not overridden by a rule above)`).toBe('13.6px');
        }
      }
      const rows = [boxes.slice(0, 2), boxes.slice(2)];
      for (const [choice, remove] of rows) expect(choice!.right, `${choice!.label} ends before ${remove!.label}`).toBeLessThanOrEqual(remove!.left);
      const name = await table
        .locator('td')
        .first()
        .evaluate((cell) => cell.getBoundingClientRect().width);
      expect(name, 'the column of the names is at least 3.5rem wide').toBeGreaterThanOrEqual(56);
      expect(await horizontalOverflow(page), 'the page does not scroll sideways: only the region may').toBe(0);
      if (width > 832) expect(await region.evaluate((e) => e.scrollWidth - e.clientWidth), 'a wide window needs no scrolling of the table').toBeLessThanOrEqual(0);
    } finally {
      await context.close();
    }
  });
}
