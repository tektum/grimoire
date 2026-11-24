import { expect, test } from '@playwright/test';
import { shots } from '../support/shots';
import { fixtureServer } from '../support/fixtures';
import { bundleHarness } from './bundle';

// Screenshots of the screens of this task, light and dark, 1280 by 800, taken from the client's own components with fake data (test-results/shots/M6-T03/).
// Run by the same command as the other browser tests; the files are what a pull request description shows.
const TASK = 'M6-T03';
const page = (id: string, parentId: string | null, position: string, title: string, icon: string | null = null) => ({ id, urlId: id.slice(0, 8).padEnd(8, '0'), parentId, position, title, icon });
const COLLECTIONS = [
  { id: 'c1', name: 'Dev', description: null, icon: null, color: null, position: 'p1', defaultPermission: 'read-write', myPermission: 'read-write' },
  { id: 'c2', name: 'Handbook', description: null, icon: null, color: null, position: 'p2', defaultPermission: 'read-write', myPermission: 'read-write' },
  { id: 'c3', name: 'Private', description: null, icon: null, color: null, position: 'p3', defaultPermission: null, myPermission: 'read-only' },
];
const PAGES = [
  page('welcome', null, 'p1', 'Welcome'),
  page('nested', 'welcome', 'p1', 'Nested'),
  page('guide', 'welcome', 'p2', 'Getting started guide'),
  page('install', 'guide', 'p1', 'Install the tools'),
  page('first', 'guide', 'p2', 'Your first page'),
  page('plan', null, 'p2', 'Plan for May'),
  page('notes', null, 'p3', 'Meeting notes'),
];

test('the collection list and the contents tree, light and dark', async ({ page: tab, browserName }) => {
  test.skip(browserName !== 'chromium', 'screenshots are taken once, in Chromium');
  const bundle = await bundleHarness('screens-harness.tsx');
  const server = await fixtureServer({ '/': '<!doctype html><meta charset="utf-8"><title>Grimoire</title><div id="host"></div>' });
  try {
    await tab.goto(server.url('/'));
    await tab.addStyleTag({ content: bundle.css });
    // This machine's default sans-serif is a monospace face, so `system-ui` would draw everything in monospace: name an installed sans for the interface text, as the shots of M6-T01 do.
    await tab.addStyleTag({ content: ":root { --font-ui: 'Liberation Sans', Arial, sans-serif; }" });
    await tab.addScriptTag({ content: bundle.js });
    await tab.evaluate(([data, id]) => { (window as unknown as { show: (d: unknown, p: string) => void }).show(data as never, id as string); }, [{ collections: COLLECTIONS, pages: PAGES }, '/c/c1']);
    await expect(tab.getByRole('treeitem')).toHaveCount(5); // Welcome is open: Welcome, Nested, Getting started guide, Plan for May, Meeting notes
    await shots(tab, TASK, 'collection-list');
    // Three levels, one row expanded and one focused, from the keyboard.
    await tab.getByRole('button', { name: 'Expand Getting started guide' }).click();
    await expect(tab.getByRole('treeitem')).toHaveCount(7);
    // The way a keyboard user arrives: Tab until a row of the tree has the focus (it is one stop), then the arrow keys move down two rows.
    for (let i = 0; i < 12 && !(await tab.evaluate(() => document.activeElement?.classList.contains('tree-item') === true)); i += 1) await tab.keyboard.press('Tab');
    await tab.keyboard.press('ArrowDown');
    await tab.keyboard.press('ArrowDown');
    await expect(tab.locator('.tree-row[data-focused]')).toHaveCount(1); // the point of this shot: one row has the focus
    await tab.mouse.move(0, 0); // no hover shade on the toggle just clicked
    await shots(tab, TASK, 'contents-tree');
  } finally {
    await server.stop();
  }
});

test('the Move to dialog, light and dark', async ({ page: tab, browserName }) => {
  test.skip(browserName !== 'chromium', 'screenshots are taken once, in Chromium');
  const bundle = await bundleHarness('screens-harness.tsx');
  const server = await fixtureServer({ '/': '<!doctype html><meta charset="utf-8"><title>Grimoire</title><div id="host"></div>' });
  try {
    await tab.goto(server.url('/'));
    await tab.addStyleTag({ content: bundle.css });
    await tab.addStyleTag({ content: ":root { --font-ui: 'Liberation Sans', Arial, sans-serif; }" }); // as above
    await tab.addScriptTag({ content: bundle.js });
    await tab.evaluate(([data, id]) => { (window as unknown as { show: (d: unknown, p: string) => void }).show(data as never, id as string); }, [{ collections: COLLECTIONS, pages: PAGES }, '/c/c1']);
    await expect(tab.getByRole('treeitem')).toHaveCount(5);
    await tab.getByRole('button', { name: 'Actions for Plan for May' }).click();
    await tab.getByRole('menuitem', { name: 'Move to…' }).click();
    await expect(tab.getByRole('dialog', { name: 'Move Plan for May to…' })).toBeVisible();
    await tab.mouse.move(0, 0);
    await shots(tab, TASK, 'move-to-dialog');
  } finally {
    await server.stop();
  }
});

/** Opens `path` of the harness with the data given, in the page of a fresh test (the same preparation as above). */
async function open(tab: import('@playwright/test').Page, path: string, data: object): Promise<() => Promise<void>> {
  const bundle = await bundleHarness('screens-harness.tsx');
  const server = await fixtureServer({ '/': '<!doctype html><meta charset="utf-8"><title>Grimoire</title><div id="host"></div>' });
  await tab.goto(server.url('/'));
  await tab.addStyleTag({ content: bundle.css });
  await tab.addStyleTag({ content: ":root { --font-ui: 'Liberation Sans', Arial, sans-serif; }" }); // as above
  await tab.addScriptTag({ content: bundle.js });
  await tab.evaluate(([d, p]) => { (window as unknown as { show: (d: unknown, p: string) => void }).show(d, p as string); }, [data, path] as const);
  return () => server.stop();
}

test('the trash with one page that can be restored, light and dark', async ({ page: tab, browserName }) => {
  test.skip(browserName !== 'chromium', 'screenshots are taken once, in Chromium');
  const stop = await open(tab, '/trash', { collections: COLLECTIONS, pages: [], trash: [{ id: 'plan', title: 'Plan for May', collectionId: 'c1', deletedAt: Date.UTC(2026, 10, 20, 9, 0), deletedBy: null, daysLeft: 26 }] });
  try {
    await expect(tab.getByRole('button', { name: 'Restore Plan for May' })).toBeVisible();
    await tab.mouse.move(0, 0);
    await shots(tab, TASK, 'trash');
  } finally {
    await stop();
  }
});

test('the not-found screen, light and dark', async ({ page: tab, browserName }) => {
  test.skip(browserName !== 'chromium', 'screenshots are taken once, in Chromium');
  const stop = await open(tab, '/nowhere/at-all', { collections: COLLECTIONS, pages: [] });
  try {
    await expect(tab.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
    await tab.mouse.move(0, 0);
    await shots(tab, TASK, 'not-found');
  } finally {
    await stop();
  }
});

test('a page open with the tree beside it, light and dark', async ({ page: tab, browserName }) => {
  test.skip(browserName !== 'chromium', 'screenshots are taken once, in Chromium');
  const stop = await open(tab, '/p/install-the-tools-install0', { collections: COLLECTIONS, pages: PAGES });
  try {
    await expect(tab.getByRole('heading', { level: 1, name: 'Install the tools' })).toBeVisible();
    await expect(tab.getByRole('link', { name: 'Install the tools', exact: true }).and(tab.locator('[aria-current="page"]'))).toBeVisible(); // the branches above the page are open and the page is marked
    await tab.mouse.move(0, 0);
    await shots(tab, TASK, 'page-with-contents');
  } finally {
    await stop();
  }
});
