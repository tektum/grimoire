import { expect, test } from '@playwright/test';
import { signInAs } from '../support/sign-in';
import { waitForSynced } from '../support/sync';
import { STOPS, stopReady } from './routes';
import { lastingMotion } from './support';
import { prepareWorld, type World } from './world';

// With reduced motion asked for, no element on any route moves: a transition is a fade of opacity of 80ms at most and no animation runs (needs the whole stack).
let world: World;

test.beforeAll(async ({ browser, baseURL }) => {
  test.slow(); // the stack side of the tour: collections, pages and a saved version
  world = await prepareWorld(browser, baseURL);
});

test('with reduced motion, nothing on any route moves: at most an 80ms fade, no animation', async ({ browser, baseURL }) => {
  test.slow();
  const failures: string[] = [];
  for (const stop of STOPS) {
    const context = await browser.newContext({ ...(baseURL === undefined ? {} : { baseURL }), viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
    try {
      if (stop.who !== 'nobody') await signInAs(context, stop.who === 'admin' ? 'e2e-admin' : 'e2e-tourist', stop.who);
      const page = await context.newPage();
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(stop.path(world));
      await stopReady(stop, page, world);
      const lasting = await lastingMotion(page);
      if (lasting.length > 0) failures.push(`${stop.route}: ${lasting.join('; ')}`);
    } finally {
      await context.close();
    }
  }
  expect(failures, 'elements with a transition or animation under reduced motion').toEqual([]);
});

test('the editor, with the slash menu open and the collaborator labels, does not move either', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ ...(baseURL === undefined ? {} : { baseURL }), viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  try {
    await signInAs(context, 'e2e-tourist', 'member');
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(world.alpha.path);
    await waitForSynced(page);
    await page.locator('.ProseMirror').locator('p', { hasText: 'A second paragraph.' }).click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('/');
    await page.getByRole('option').first().waitFor();
    expect(await lastingMotion(page)).toEqual([]);
  } finally {
    await context.close();
  }
});
