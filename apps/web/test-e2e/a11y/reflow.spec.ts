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
