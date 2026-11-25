import { expect, test, type Page } from '@playwright/test';
import { mockApi } from '../collections/mock-api';
import { signInAs } from '../support/sign-in';
import { hit, scriptedSearch } from './support';

// The matched passage of a result (M7-contracts 15.5): plain text under the snippet, never markup; and what a narrow window does with a long one. Against the stand-in of the API and the scripted search.
const HOSTILE = '<img src=x onerror=alert(1)>';
const LONG = `${'The passage that matched by meaning, a long run of ordinary words '.repeat(5)}`.slice(0, 300);

async function open(page: Page, context: Parameters<typeof signInAs>[0], items: unknown[]) {
  await signInAs(context, 'e2e-alice', 'member', { check: false });
  await mockApi(page, { collections: [{ id: 'c1', name: 'Dev', myPermission: 'read-write' }], pages: [] });
  await scriptedSearch(page, () => ({ items }));
}

test('a passage that is markup is shown as literal text and no script runs', async ({ page, context }) => {
  await open(page, context, [hit('r1', 'r1000000', 'Product plan', 'a snippet with plan', [[15, 19]], { matchedPassage: { text: HOSTILE } })]);
  await page.addInitScript(() => {
    (window as unknown as { ran: number }).ran = 0;
    window.alert = () => {
      (window as unknown as { ran: number }).ran += 1;
    };
  });
  await page.goto('/search?q=plan');
  const passage = page.locator('.search-passage');
  await expect(passage).toHaveText(HOSTILE);
  await expect(page.locator('.search-result img')).toHaveCount(0);
  await expect(page.locator('.search-result mark')).toHaveText('plan'); // the snippet is kept beside it
  expect(await page.evaluate(() => (window as unknown as { ran: number }).ran)).toBe(0);
});

test('a result without a passage has no extra line', async ({ page, context }) => {
  await open(page, context, [hit('r1', 'r1000000', 'Product plan', 'only a snippet', [[0, 4]])]);
  await page.goto('/search?q=only');
  await expect(page.locator('.search-result')).toHaveCount(1);
  await expect(page.locator('.search-passage')).toHaveCount(0);
  await expect(page.locator('.search-result p')).toHaveCount(1);
});

test('a passage of 300 characters wraps without horizontal overflow at 320 px, and a long word does too', async ({ page, context }) => {
  expect(LONG).toHaveLength(300);
  await open(page, context, [hit('r1', 'r1000000', 'x'.repeat(120), 'y'.repeat(150), [[0, 5]], { matchedPassage: { text: `${LONG.slice(0, 150)}${'z'.repeat(150)}` } })]);
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto('/search?q=x');
  await expect(page.locator('.search-passage')).toBeVisible();
  const overflow = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth - window.innerWidth,
    result: (() => {
      const el = document.querySelector('.search-result')!;
      return el.scrollWidth - el.clientWidth;
    })(),
  }));
  expect(overflow.page, 'the page does not scroll sideways').toBeLessThanOrEqual(0);
  expect(overflow.result, 'the result does not overflow itself').toBeLessThanOrEqual(0);
});
