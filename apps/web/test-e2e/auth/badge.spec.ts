import { expect, test, type Locator, type Page } from '@playwright/test';
import { devSecret } from '../support/env';
import { pointAtApi } from './support';

// The badge of the header (who is signed in, the role, Sign out) against the stack (`make up` with compose.m6.yaml, local mode) and a test build of the client. The way out of the app
// must not only be in the document: it must have a box, be inside the window, and be readable, in both colour schemes and in a narrow window (an owner's header once showed none of it).
const MIN_CONTRAST = 4.5;

async function signIn(page: Page, userId: string, role: string) {
  await pointAtApi(page);
  await page.goto('/login?return=%2Fsearch');
  await page.getByLabel('User id').fill(userId);
  await page.getByLabel('Role').selectOption(role);
  await page.getByLabel('Secret').fill(devSecret());
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/search$/);
}

/** The contrast ratio of the text of an element with the colour it is drawn on (the first background up the tree that is not transparent), both as the engine computes them. */
async function contrastOf(locator: Locator): Promise<number> {
  return locator.evaluate((element) => {
    const channels = (css: string) => (css.match(/[\d.]+/g) ?? []).map(Number);
    const luminance = ([r = 0, g = 0, b = 0]: number[]) => {
      const lin = (v: number) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
      return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    };
    const text = channels(getComputedStyle(element).color);
    let node: Element | null = element;
    let background = [255, 255, 255];
    while (node !== null) {
      const parts = channels(getComputedStyle(node).backgroundColor);
      if (parts.length >= 3 && (parts[3] ?? 1) > 0.99) {
        background = parts;
        break;
      }
      node = node.parentElement;
    }
    const [hi, lo] = [luminance(text), luminance(background)].sort((a, b) => b - a) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  });
}

async function expectSeen(page: Page, target: Locator, label: string) {
  await expect(target, `${label} is visible`).toBeVisible();
  const box = (await target.boundingBox())!;
  const view = page.viewportSize()!;
  expect(box.width, `${label} has a width`).toBeGreaterThan(8);
  expect(box.height, `${label} has a height`).toBeGreaterThan(8);
  expect(box.x, `${label} starts inside the window`).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, `${label} ends inside the window`).toBeLessThanOrEqual(view.width + 0.5);
  expect(box.y + box.height, `${label} is in the first screenful`).toBeLessThanOrEqual(view.height);
  expect(await contrastOf(target), `${label} is readable (contrast)`).toBeGreaterThanOrEqual(MIN_CONTRAST);
}

for (const scheme of ['light', 'dark'] as const) {
  for (const width of [1280, 360]) {
    test(`the name, the role and Sign out are in the header, with a box and a contrast, in the ${scheme} scheme at ${width} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.emulateMedia({ colorScheme: scheme });
      await signIn(page, 'e2e-alice', 'admin');
      const badge = page.locator('.shell-header .user-badge');
      await expectSeen(page, badge.getByTestId('user-name'), 'the name');
      await expectSeen(page, badge.getByTestId('user-role'), 'the role');
      await expectSeen(page, badge.getByRole('button', { name: 'Sign out' }), 'Sign out');
    });
  }
}
