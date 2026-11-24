import { expect, test } from '@playwright/test';
import { makePage } from '../editor/pages';
import { signInAs } from '../support/sign-in';
import { waitForSynced } from '../support/sync';

// Needs the whole stack, like the other specs of the live editor. A page with headings A (level 1), B (level 2) and C (level 1), viewport 1400 wide.
const MARKDOWN = '# A\n\nFirst.\n\n## B\n\nSecond.\n\n# C\n\n' + 'Filler.\n\n'.repeat(40) + 'The end.\n';

test.describe('the outline of a live page', () => {
  test('lists A, B, C in order with B one step in; a new heading appears within 1 s; a click on C scrolls and puts the cursor in it', async ({ browser, baseURL }) => {
    const made = await makePage(MARKDOWN, { permission: 'read_write' });
    const context = await browser.newContext({ ...(baseURL === undefined ? {} : { baseURL }), viewport: { width: 1400, height: 800 } });
    try {
      await signInAs(context, 'e2e-alice', 'member');
      const page = await context.newPage();
      await page.goto(made.path);
      await waitForSynced(page);
      const links = page.getByRole('navigation', { name: 'Page outline' }).getByRole('link');
      await expect(links).toHaveText(['A', 'B', 'C']);
      expect(await links.evaluateAll((all) => all.map((a) => a.getAttribute('data-indent')))).toEqual(['0', '1', '0']);

      await page.locator('.ProseMirror').click();
      await page.keyboard.press('Control+End');
      await page.keyboard.press('Enter');
      await page.keyboard.type('## Typed heading');
      await expect(links).toHaveText(['A', 'B', 'C', 'Typed heading'], { timeout: 1000 });

      await page.getByRole('navigation', { name: 'Page outline' }).getByRole('link', { name: 'C', exact: true }).click();
      await expect(page.locator('.ProseMirror h1', { hasText: 'C' })).toBeInViewport();
      const inside = await page.evaluate(() => {
        const anchor = window.getSelection()?.anchorNode;
        const heading = Array.from(document.querySelectorAll('.ProseMirror h1')).find((h) => h.textContent === 'C');
        return anchor !== null && anchor !== undefined && heading !== undefined && heading.contains(anchor);
      });
      expect(inside).toBe(true);
    } finally {
      await context.close();
    }
  });

  test('at 1000 pixels wide the outline is not rendered', async ({ browser, baseURL }) => {
    const made = await makePage(MARKDOWN, { permission: 'read_write' });
    const context = await browser.newContext({ ...(baseURL === undefined ? {} : { baseURL }), viewport: { width: 1000, height: 800 } });
    try {
      await signInAs(context, 'e2e-alice', 'member');
      const page = await context.newPage();
      await page.goto(made.path);
      await waitForSynced(page);
      await expect(page.locator('.ProseMirror h1').first()).toBeVisible();
      await expect(page.getByRole('navigation', { name: 'Page outline' })).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
