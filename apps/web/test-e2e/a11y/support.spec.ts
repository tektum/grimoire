import { expect, test } from '@playwright/test';
import { ROUTES } from '../../src/app/routes';
import { fixtureServer, type FixtureServer } from '../support/fixtures';
import { STOPS } from './routes';
import { addressOf } from './world';
import { COUNT_POINTER_EVENTS, axeBothSchemes, blockingText, lastingMotion, pointerEvents, summaryLine, tabTo } from './support';

// What the tour, the keyboard walk and the motion check stand on, tried on small pages: no stack is needed.
let server: FixtureServer;

const PAGE = (body: string, style = ''): string => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title><style>${style}</style></head><body><main>${body}</main></body></html>`;

test.beforeAll(async () => {
  server = await fixtureServer({
    '/buttons': PAGE('<h1>Buttons</h1><button id="a">First</button><button id="b">Second</button>'),
    '/moving': PAGE('<h1>Moving</h1><button class="slow">Slow</button>', '.slow{transition:opacity 120ms ease}.spin{animation:s 2s infinite}@keyframes s{to{opacity:.5}}'),
    '/still': PAGE('<h1>Still</h1><button class="slow">Slow</button>', '.slow{transition:opacity 120ms ease}@media (prefers-reduced-motion: reduce){*{transition:none!important;animation:none!important}}'),
    '/clean': PAGE('<h1>Clean</h1><button>Named</button>'),
    '/fading': PAGE(
      '<h1>Fading</h1><button>Fades</button>',
      'button{color:#000;background:#fff;border:1px solid #000;transition:background 3s}@media (prefers-color-scheme: dark){body{background:#000}button{color:#fff;background:#000;border-color:#fff}}@media (prefers-reduced-motion: reduce){*{transition:none!important}}',
    ),
    '/late': PAGE(
      '<h1>Late</h1><button>Early</button><script>setTimeout(() => { const b = document.createElement("button"); b.id = "late"; b.textContent = "Late"; document.querySelector("main").append(b); }, 600);</script>',
    ),
    '/skipped': PAGE('<h1>Skipped</h1><button id="a">First</button><button>Second</button><div id="skipped" tabindex="-1">Not in the Tab order</div><button id="off" disabled>Off</button>'),
    '/broken': PAGE('<h1>Broken</h1><button></button>'),
  });
});
test.afterAll(async () => server.stop());

test('the tour has a stop for every route of the route table, and none twice', () => {
  const stops = STOPS.map((s) => s.route);
  expect(
    [...ROUTES.map((r) => r.path), '/'].filter((route) => !stops.includes(route)),
    'routes with no stop in a11y/routes.ts',
  ).toEqual([]);
  expect(new Set(stops).size, 'a route with two stops').toBe(stops.length);
});

test('the routes whose screens are not built are named, with the task that builds them', () => {
  expect(STOPS.filter((s) => s.pending !== undefined).map((s) => `${s.route} pending ${s.pending}`)).toEqual(['/search pending M6-T09', '/import pending M6-T12a']);
});

test('the address of a page is matched by its id, whatever the slug', () => {
  const address = addressOf('qwgiePoP97');
  for (const url of ['http://x/p/page-qwgiePoP97', 'http://x/p/beta-9cff9a43-qwgiePoP97', 'http://x/p/qwgiePoP97']) expect(url).toMatch(address);
  for (const url of ['http://x/p/page-qwgiePoP98', 'http://x/p/qwgiePoP97/history', 'http://x/p/xqwgiePoP97']) expect(url).not.toMatch(address);
});

test('a route that has no stop is found', () => {
  const stops = STOPS.filter((s) => s.route !== '/trash').map((s) => s.route);
  expect([...ROUTES.map((r) => r.path), '/'].filter((route) => !stops.includes(route))).toEqual(['/trash']);
});

test('the pointer count is zero for keys, even Enter on a button (a click made by a key), and grows with a mouse click', async ({ page }) => {
  await page.addInitScript(COUNT_POINTER_EVENTS);
  await page.goto(server.url('/buttons'));
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  expect(await pointerEvents(page)).toBe(0);
  await page.locator('#b').click();
  expect(await pointerEvents(page)).toBeGreaterThanOrEqual(2);
  await page.goto(server.url('/buttons')); // a page loaded again keeps the count
  expect(await pointerEvents(page)).toBeGreaterThanOrEqual(2);
});

test('Tab reaches the element asked for, also with the very last press allowed', async ({ page }) => {
  await page.goto(server.url('/buttons'));
  await tabTo(page, page.locator('#b'));
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('b');
  await page.goto(server.url('/buttons'));
  await tabTo(page, page.locator('#b'), { limit: 2 }); // the second press reaches it: not "never reached"
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('b');
  await page.goto(server.url('/buttons'));
  await expect(tabTo(page, page.locator('#b'), { limit: 1 })).rejects.toThrow(/never reached/);
});

test('it waits for an element that is drawn late, and says when the element is not there at all', async ({ page }) => {
  await page.goto(server.url('/late'));
  await tabTo(page, page.locator('#late')); // drawn 600 ms after the page: the walk does not start before it is there
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('late');
  await page.goto(server.url('/buttons'));
  await expect(tabTo(page, page.locator('#nowhere'), { timeout: 300 })).rejects.toThrow(/not on the page, or not visible/);
});

test('an element that is there and that Tab skips is told apart from one that is not: the error names its tag and tabindex, and the elements the focus went over', async ({ page }) => {
  await page.goto(server.url('/skipped'));
  await expect(tabTo(page, page.locator('#skipped'), { limit: 5 })).rejects.toThrow(/the element is there, <div tabindex="-1">, and Tab skips it.*it went over:(?=.*button "First")(?=.*button "Second")/s);
  await page.goto(server.url('/skipped'));
  await expect(tabTo(page, page.locator('#off'), { limit: 5 })).rejects.toThrow(/<button disabled>, and Tab skips it/);
});

test('a transition or an animation that lasts is found, and nothing is under reduced motion', async ({ page }) => {
  await page.goto(server.url('/moving'));
  expect((await lastingMotion(page)).join('\n')).toMatch(/button\.slow \(transition 0\.12s/);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(server.url('/still'));
  expect(await lastingMotion(page)).toEqual([]);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(server.url('/still'));
  expect((await lastingMotion(page)).length).toBeGreaterThan(0);
});

test('axe does not measure the colours of a button that is still changing with the scheme', async ({ page }) => {
  await page.goto(server.url('/fading'));
  expect(blockingText(await axeBothSchemes(page, 'fading'))).toBe('');
});

test('axe is run in both schemes: a clean page reports nothing serious, a button with no name is critical, and the scheme is put back', async ({ page }) => {
  await page.goto(server.url('/clean'));
  const clean = await axeBothSchemes(page, 'clean');
  expect(clean.map((r) => r.scheme)).toEqual(['light', 'dark']);
  expect(blockingText(clean)).toBe('');
  await page.goto(server.url('/broken'));
  const broken = await axeBothSchemes(page, 'broken');
  expect(blockingText(broken)).toMatch(/broken \(light\):\n {2}critical button-name/);
  expect(summaryLine(broken[0]!)).toMatch(/^broken \(light\): 1 serious or critical, \d+ moderate or minor$/);
  expect(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(false);
});
