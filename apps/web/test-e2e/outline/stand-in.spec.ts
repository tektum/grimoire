import { expect, test } from '@playwright/test';
import { historyApi, SLUG } from '../history/mock-api';
import { expectNoAxeViolations } from '../support/axe';
import { signInAs } from '../support/sign-in';

// The outline against a stand-in API: the page's saved text is drawn by the read-only editor while the live connection is not there, so the outline's work on what the
// editor draws can be checked without the stack (the live editor is in outline.spec.ts, which needs it). Needs a development build of the client (`bunx vite build --mode e2e`).
const MARKDOWN = '# A\n\nFirst.\n\n## B\n\nSecond.\n\n# C\n\n' + 'Filler line.\n\n'.repeat(60) + '### Deep\n\nEnd.\n';
const STATE = { role: 'member' as const, current: MARKDOWN, revisions: [] };

async function open(page: import('@playwright/test').Page, width: number) {
  await page.setViewportSize({ width, height: 800 });
  await historyApi(page, STATE);
  await page.goto(`/p/${SLUG}`);
  await expect(page.getByTestId('editor-root').locator('h1', { hasText: 'A' })).toBeVisible();
}

test.beforeEach(async ({ context }) => { await signInAs(context, 'e2e-alice', 'member', { check: false }); });

test('at 1400 pixels the outline lists A, B, C and the deep heading in order, B one step in', async ({ page }) => {
  await open(page, 1400);
  const nav = page.getByRole('navigation', { name: 'Page outline' });
  await expect(nav.getByRole('link')).toHaveText(['A', 'B', 'C', 'Deep']);
  expect(await nav.getByRole('link').evaluateAll((links) => links.map((a) => a.getAttribute('data-indent')))).toEqual(['0', '1', '0', '2']);
  const pad = await nav.getByRole('link').evaluateAll((links) => links.map((a) => parseFloat(getComputedStyle(a).paddingInlineStart)));
  expect(pad[1]).toBeGreaterThan(pad[0] ?? 0);
  expect(pad[0]).toBe(pad[2]);
});

test('at 1000 pixels the outline is not rendered', async ({ page }) => {
  await open(page, 1000);
  await expect(page.getByRole('navigation', { name: 'Page outline' })).toHaveCount(0);
});

test('a click on C scrolls it into view and puts the cursor in it', async ({ page }) => {
  await open(page, 1400);
  await page.getByRole('navigation', { name: 'Page outline' }).getByRole('link', { name: 'Deep' }).click();
  await expect(page.getByTestId('editor-root').locator('h3')).toBeInViewport();
  const inside = await page.evaluate(() => {
    const anchor = window.getSelection()?.anchorNode;
    const heading = document.querySelector('.page-editor h3');
    return anchor !== null && anchor !== undefined && heading !== null && heading.contains(anchor);
  });
  expect(inside).toBe(true);
  await expect(page.getByRole('navigation', { name: 'Page outline' }).getByRole('link', { name: 'Deep' })).toHaveAttribute('aria-current', 'location');
});

test('Tab reaches the outline, the arrow keys and Enter go to a heading, and axe is clean', async ({ page }) => {
  await open(page, 1400);
  const nav = page.getByRole('navigation', { name: 'Page outline' });
  await expect(nav.getByRole('link')).toHaveCount(4);
  await expectNoAxeViolations(page, { minImpact: 'serious' });
  const inOutline = (): Promise<boolean> => page.evaluate(() => document.activeElement?.closest('nav[aria-label="Page outline"]') != null);
  for (let i = 0; i < 40 && !(await inOutline()); i += 1) await page.keyboard.press('Tab');
  expect(await inOutline()).toBe(true);
  await expect(nav.getByRole('link', { name: 'A' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(nav.getByRole('link', { name: 'C' })).toBeFocused();
  await page.keyboard.press('Enter');
  const inside = await page.evaluate(() => {
    const anchor = window.getSelection()?.anchorNode;
    const heading = Array.from(document.querySelectorAll('.page-editor h1')).find((h) => h.textContent === 'C');
    return anchor != null && heading !== undefined && heading.contains(anchor);
  });
  expect(inside).toBe(true);
});

test('the outline stays in view while a long page is read', async ({ page }) => {
  await open(page, 1400);
  const nav = page.getByRole('navigation', { name: 'Page outline' });
  await expect(nav).toBeInViewport();
  await page.evaluate(() => { for (const element of [document.scrollingElement, ...document.querySelectorAll('main, .shell-main, .shell-content')]) element?.scrollTo?.(0, 1e6); });
  await expect(page.getByTestId('editor-root').locator('h3')).toBeInViewport(); // the end of the page: the page did scroll
  await expect(nav).toBeInViewport();
  // Far down, the heading that has passed the top of the window is the current one (C: the next heading, Deep, is still below the top).
  await expect(nav.getByRole('link', { name: 'C' })).toHaveAttribute('aria-current', 'location');
});

test('the stand-in tells the page a collaboration address nothing listens on, so a stack on the same host cannot refuse it and sign the page out', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 800 });
  await historyApi(page, STATE);
  const config = page.waitForResponse((response) => new URL(response.url()).pathname === '/v1/config');
  await page.goto(`/p/${SLUG}`);
  const { collabUrl } = (await (await config).json()) as { collabUrl: string };
  expect(new URL(collabUrl).port).toBe('1');
  await expect(page.getByTestId('editor-root').locator('h1', { hasText: 'A' })).toBeVisible();
  expect(page.url()).toContain(`/p/${SLUG}`); // still on the page, not on the sign-in screen
});
