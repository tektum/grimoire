import { expect, test } from '@playwright/test';
import type { FlatPage } from '../../src/tree/model';
import { fixtureServer } from '../support/fixtures';
import { bundleHarness } from './bundle';

// The first screen of a collection with 5,000 pages (R11.4): drawn in under 500 ms (ten times the 33 ms measured when this budget was set) and holding
// fewer than 100 rows in the page, because only the visible window is drawn. Chromium only: the number is a Chromium measurement.
const PAGES = 5000;
const BUDGET_MS = 500;
const ROW_LIMIT = 100;

/** Three levels: 50 roots, each with 9 children, each with 10 grandchildren (50 + 450 + 4,500 pages). */
function generated(): FlatPage[] {
  const pages: FlatPage[] = [];
  const add = (id: string, parentId: string | null, n: number): void => {
    pages.push({ id, urlId: id.slice(0, 8), parentId, position: `p${String(n).padStart(5, '0')}`, title: `Page ${id}`, icon: null });
  };
  for (let a = 0; a < 50; a += 1) {
    add(`a${String(a)}`, null, a);
    for (let b = 0; b < 9; b += 1) {
      add(`b${String(a)}-${String(b)}`, `a${String(a)}`, b);
      for (let c = 0; c < 10; c += 1) add(`c${String(a)}-${String(b)}-${String(c)}`, `b${String(a)}-${String(b)}`, c);
    }
  }
  return pages;
}

test('5,000 pages: the first screen is drawn within the budget and the page holds fewer than 100 rows', async ({ page, browserName }, info) => {
  test.skip(browserName !== 'chromium', 'the budget is a Chromium measurement');
  const { js } = await bundleHarness('perf-harness.tsx');
  const server = await fixtureServer({ '/': '<!doctype html><meta charset="utf-8"><title>tree</title><div id="host"></div>' });
  try {
    await page.goto(server.url('/'));
    await page.addScriptTag({ content: js });
    const pages = generated();
    expect(pages).toHaveLength(PAGES);
    const ms = await page.evaluate((p) => (window as unknown as { drawTree: (x: unknown) => number }).drawTree(p), pages);
    const rows = await page.locator('[role="treeitem"]').count();
    info.annotations.push({ type: 'measured', description: `${ms.toFixed(1)} ms, ${String(rows)} rows` });
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(rows).toBeGreaterThan(0);
    expect(rows).toBeLessThan(ROW_LIMIT);
  } finally {
    await server.stop();
  }
});
