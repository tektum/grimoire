import { expect, test, type Page } from '@playwright/test';
import { makePage } from '../editor/pages';
import { waitForSynced } from '../support/sync';
import { twoUsers } from '../support/two-users';
import { surface } from './support';

/** The boxes of the block handle and of the text of the nth block, as the browser lays them out. */
async function boxes(page: Page, index: number): Promise<{ handle: { left: number; right: number; top: number; bottom: number }; text: { left: number; right: number; top: number; bottom: number } }> {
  return page.evaluate((n) => {
    const box = (r: DOMRect) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
    const handle = document.querySelector('.block-handle[data-show="true"] .block-handle-button');
    const block = document.querySelector('.ProseMirror')!.children[n]!;
    const range = document.createRange();
    range.selectNodeContents(block);
    return { handle: box(handle!.getBoundingClientRect()), text: box(range.getBoundingClientRect()) };
  }, index);
}

test.describe('the block handle', () => {
  test('is drawn beside the block it is on, for the first block and the others: its box never meets the text of the block', async ({ browser, baseURL }) => {
    const made = await makePage('The first block of the page.\n\nThe second block of the page.\n\nThe third block.\n');
    const users = await twoUsers(browser, baseURL);
    try {
      const { page } = users.a;
      await page.goto(made.path);
      await waitForSynced(page);
      for (const [index, text] of ['The first block', 'The second block', 'The third block'].entries()) {
        await surface(page).locator('p', { hasText: text }).hover();
        await expect(page.locator('.block-handle[data-show="true"]')).toBeVisible();
        // The handle moves to the block the pointer is on a moment after the pointer gets there: wait until it is level with it.
        await expect
          .poll(
            async () => {
              const { handle, text: block } = await boxes(page, index);
              return handle.bottom > block.top && handle.top < block.bottom;
            },
            { message: `the handle is level with block ${index + 1}` },
          )
          .toBe(true);
        const { handle, text: block } = await boxes(page, index);
        expect(handle.right, `the handle of block ${index + 1} ends before its text begins`).toBeLessThanOrEqual(block.left);
      }
    } finally {
      await users.close();
    }
  });
});
