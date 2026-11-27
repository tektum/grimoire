import { expect, test } from '@playwright/test';
import { ROUTES } from '../../src/app/routes';
import { fixtureServer, type FixtureServer } from '../support/fixtures';
import { STOPS } from './routes';
import { addressOf } from './world';
import { COUNT_POINTER_EVENTS, axeBothSchemes, expectEditable, blockingText, focusWithoutIndicator, horizontalOverflow, lastingMotion, pointerEvents, summaryLine, tabTo } from './support';

// What the tour, the keyboard walk and the motion check stand on, tried on small pages: no stack is needed.
let server: FixtureServer;

const PAGE = (body: string, style = ''): string => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title><style>${style}</style></head><body><main>${body}</main></body></html>`;

test.beforeAll(async () => {
  server = await fixtureServer({
    '/buttons': PAGE('<h1>Buttons</h1><button id="a">First</button><button id="b">Second</button>'),
    '/links': PAGE('<h1>Links</h1><a id="l" href="#x">A link</a><button id="s">A button</button>'),
    '/moving': PAGE('<h1>Moving</h1><button class="slow">Slow</button>', '.slow{transition:opacity 120ms ease}.spin{animation:s 2s infinite}@keyframes s{to{opacity:.5}}'),
    '/still': PAGE('<h1>Still</h1><button class="slow">Slow</button>', '.slow{transition:opacity 120ms ease}@media (prefers-reduced-motion: reduce){*{transition-property:opacity!important;transition-duration:80ms!important;animation:none!important}}'),
    '/slides': PAGE('<h1>Slides</h1><button class="slide">Slide</button>', '.slide{transition:transform 80ms ease}'),
    '/clean': PAGE('<h1>Clean</h1><button>Named</button>'),
    '/fading': PAGE(
      '<h1>Fading</h1><button>Fades</button>',
      'button{color:#000;background:#fff;border:1px solid #000;transition:background 3s}@media (prefers-color-scheme: dark){body{background:#000}button{color:#fff;background:#000;border-color:#fff}}@media (prefers-reduced-motion: reduce){*{transition:none!important}}',
    ),
    '/late': PAGE(
      '<h1>Late</h1><button>Early</button><script>setTimeout(() => { const b = document.createElement("button"); b.id = "late"; b.textContent = "Late"; document.querySelector("main").append(b); }, 600);</script>',
    ),
    '/skipped': PAGE('<h1>Skipped</h1><button id="a">First</button><button>Second</button><div id="skipped" tabindex="-1">Not in the Tab order</div><button id="off" disabled>Off</button>'),
    '/wide': PAGE('<h1>Wide</h1><div style="width:900px">wide</div>'),
    '/wraps': PAGE('<h1>Wraps</h1><div style="display:flex;flex-wrap:wrap"><span style="width:200px">a</span><span style="width:200px">b</span></div>'),
    '/rings': PAGE(
      '<h1>Rings</h1><a href="#" id="ring">With a ring</a><a href="#" id="bare" style="outline:none">Without</a><div tabindex="0" id="row" style="outline:none"><span data-focused style="outline:2px solid red">inner</span></div>',
    ),
    '/readonly': PAGE('<h1>Read</h1><p role="status">Read only</p><div data-collab-state="synced"><div class="ProseMirror" contenteditable="false">text</div></div>'),
    '/editable': PAGE('<h1>Edit</h1><p role="status">Saved</p><div data-collab-state="synced"><div class="ProseMirror" contenteditable="true">text</div></div>'),
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

test('a route whose screen is not built is named with the task that builds it', () => {
  for (const stop of STOPS.filter((s) => s.pending !== undefined)) expect(stop.pending, `${stop.route} names its task`).toMatch(/^M\d+-T\d+[a-z]?$/);
});

test('an editor that is not editable is reported with the connection state and the status line', async ({ page }) => {
  await page.goto(server.url('/readonly'));
  await expect(expectEditable(page, 300)).rejects.toThrow(/contenteditable="false", connection state "synced", status line "Read only"/);
  await page.goto(server.url('/editable'));
  await expectEditable(page, 300);
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

test('Enter on a link counts for no pointer, in every engine (Firefox gives that click detail 1), nor does a click that a library makes by calling click()', async ({ page }) => {
  await page.addInitScript(COUNT_POINTER_EVENTS);
  await page.goto(server.url('/links'));
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter'); // the link
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter'); // the button
  await page.evaluate(() => document.getElementById('s')!.click()); // what the menu of the interface library does for Enter on an item
  expect(await pointerEvents(page), 'keys, and a call of click(), made those clicks').toBe(0);
  await page.locator('#s').click();
  expect(await pointerEvents(page), 'a mouse made this one').toBeGreaterThan(0);
});

test("a press that a script makes is not the browser's, and so is not a pointer", async ({ page }) => {
  await page.addInitScript(COUNT_POINTER_EVENTS);
  await page.goto(server.url('/links'));
  await page.evaluate(() => document.getElementById('s')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
  expect(await pointerEvents(page)).toBe(0);
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

test('a transition or an animation that lasts is found, and under reduced motion only an 80ms fade is left', async ({ page }) => {
  await page.goto(server.url('/moving'));
  expect((await lastingMotion(page)).join('\n')).toMatch(/button\.slow \(transition 0\.12s/);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(server.url('/still'));
  expect(await lastingMotion(page)).toEqual([]);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(server.url('/still'));
  expect((await lastingMotion(page)).length).toBeGreaterThan(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(server.url('/slides'));
  expect((await lastingMotion(page)).join('\n'), 'a transform moves, however short').toMatch(/button\.slide \(transition 0\.08s of transform/);
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

test('a page that scrolls sideways is found, and one that wraps is not', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto(server.url('/wide'));
  expect(await horizontalOverflow(page)).toBeGreaterThan(500);
  await page.goto(server.url('/wraps'));
  expect(await horizontalOverflow(page)).toBe(0);
});

test('an element that takes the focus and shows none is named; a ring on the element or on its marked descendant counts', async ({ page }) => {
  await page.goto(server.url('/rings'));
  expect(await focusWithoutIndicator(page, 6)).toEqual(['a "Without"']);
});
