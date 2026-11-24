import { expect, test } from '@playwright/test';
import { axeViolations } from '../support/axe';
import { signInAs } from '../support/sign-in';
import { STOPS, stopReady } from './routes';
import { focusWithoutIndicator } from './support';
import { prepareWorld, type World } from './world';

// With the system's colours forced (high contrast), every route still shows where the focus is, and axe finds nothing serious (needs the whole stack).
let world: World;

test.beforeAll(async ({ browser, baseURL }) => {
  test.slow(); // the stack side of the tour: collections, pages and a saved version
  world = await prepareWorld(browser, baseURL);
});

test('in forced colours every route shows the focus and has no serious or critical violation', async ({ browser, baseURL }) => {
  test.slow();
  const failures: string[] = [];
  for (const stop of STOPS) {
    const context = await browser.newContext({ ...(baseURL === undefined ? {} : { baseURL }), viewport: { width: 1280, height: 800 }, forcedColors: 'active' });
    try {
      if (stop.who !== 'nobody') await signInAs(context, stop.who === 'admin' ? 'e2e-admin' : 'e2e-tourist', stop.who);
      const page = await context.newPage();
      await page.goto(stop.path(world));
      await stopReady(stop, page, world);
      expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches), 'forced colours are on').toBe(true);
      const bare = await focusWithoutIndicator(page);
      if (bare.length > 0) failures.push(`${stop.route}: no focus indicator on ${bare.join(', ')}`);
      const violations = await axeViolations(page, { minImpact: 'serious' });
      for (const v of violations) failures.push(`${stop.route}: ${v.impact} ${v.id} (${v.targets.join('; ')})`);
    } finally {
      await context.close();
    }
  }
  expect(failures, 'findings in forced colours').toEqual([]);
});
