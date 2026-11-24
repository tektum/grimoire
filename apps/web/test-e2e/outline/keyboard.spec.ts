import { expect, test } from '@playwright/test';
import { makePage } from '../editor/pages';
import { expectNoAxeViolations } from '../support/axe';
import { signInAs } from '../support/sign-in';
import { waitForSynced } from '../support/sync';

// Needs the whole stack: Tab reaches the outline, the arrow keys and Enter move to a heading, with no mouse call; no serious or critical axe violation on the page with the outline.
test('Tab reaches the outline; the arrow keys and Enter go to a heading; axe is clean', async ({ browser, baseURL }) => {
  const made = await makePage('# One\n\nText.\n\n## Two\n\nText.\n\n## Three\n\nText.\n', { permission: 'read_write' });
  const context = await browser.newContext({ ...(baseURL === undefined ? {} : { baseURL }), viewport: { width: 1400, height: 800 } });
  try {
    await signInAs(context, 'e2e-alice', 'member');
    const page = await context.newPage();
    await page.goto(made.path);
    await waitForSynced(page);
    const nav = page.getByRole('navigation', { name: 'Page outline' });
    await expect(nav.getByRole('link')).toHaveText(['One', 'Two', 'Three']);
    await expectNoAxeViolations(page, { minImpact: 'serious' });

    const inOutline = (): Promise<boolean> => page.evaluate(() => document.activeElement?.closest('nav[aria-label="Page outline"]') !== null && document.activeElement?.closest('nav[aria-label="Page outline"]') !== undefined);
    for (let i = 0; i < 40 && !(await inOutline()); i += 1) await page.keyboard.press('Tab');
    expect(await inOutline()).toBe(true);
    await expect(nav.getByRole('link', { name: 'One' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(nav.getByRole('link', { name: 'Three' })).toBeFocused();
    await page.keyboard.press('Enter');
    const inside = await page.evaluate(() => {
      const anchor = window.getSelection()?.anchorNode;
      const heading = Array.from(document.querySelectorAll('.ProseMirror h2')).find((h) => h.textContent === 'Three');
      return anchor !== null && anchor !== undefined && heading !== undefined && heading.contains(anchor);
    });
    expect(inside).toBe(true);
  } finally {
    await context.close();
  }
});
