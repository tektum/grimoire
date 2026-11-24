import { expect, test } from '@playwright/test';
import { signInAs } from '../support/sign-in';
import { mockApi } from './mock-api';

process.env['E2E_DEV_TOKEN_SECRET'] ??= 'collections-specs-secret-0001';

// The tree is read again on a return to the window and every 60 s (R11.4), and not otherwise. Needs a development build of the client:
// `bunx vite build --mode e2e` in apps/web. The API is stood in for by `mockApi`, which counts the reads of the tree.
const page0 = (id: string, title: string) => ({ id, urlId: id.padEnd(8, '0'), parentId: null, position: `p${id}`, title, icon: null });

test.describe('the tree refetches', () => {
  test.beforeEach(async ({ context }) => {
    await signInAs(context, 'e2e-alice', 'member', { check: false });
  });

  test('exactly once more on window focus, and exactly once more after 60 s', async ({ page }) => {
    const api = await mockApi(page, { collections: [{ id: 'c1', name: 'Dev', myPermission: 'read-write' }], pages: [page0('a', 'Welcome')] });
    await page.clock.install();
    await page.goto('/c/c1');
    await expect(page.getByRole('treeitem')).toHaveCount(1);
    await expect.poll(() => api.treeReads('c1')).toBe(1);

    await page.evaluate(() => { window.dispatchEvent(new Event('focus')); });
    await expect.poll(() => api.treeReads('c1')).toBe(2);

    // Not before the minute is out: 59 s later nothing was read (a real pause lets a read that was started reach the counter), and 1 s later exactly one.
    await page.clock.runFor(59_000);
    await page.waitForTimeout(300); // real time: the page clock is stopped
    expect(api.treeReads('c1')).toBe(2);
    await page.clock.runFor(1_000);
    await expect.poll(() => api.treeReads('c1')).toBe(3);

    // And no more than that: a further 10 s adds nothing.
    await page.clock.runFor(10_000);
    await page.waitForTimeout(300);
    expect(api.treeReads('c1')).toBe(3);
  });
});
