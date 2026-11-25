import { expect, test } from '@playwright/test';
import { devSecret } from '../support/env';
import { DEV_TOKEN_STORAGE_KEY } from '../support/sign-in';
import { pointAtApi } from './support';

// After a development sign-in on the sign-in document, the browser lands on the `?return=` path of the main document, with the stored session.
test.describe('the return path', () => {
  test('lands on the page asked for, signed in', async ({ page }) => {
    await pointAtApi(page);
    await page.goto('/login?return=%2Ftrash');
    await page.getByLabel('User id').fill('e2e-alice');
    await page.getByLabel('Secret').fill(devSecret());
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/trash$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Trash' })).toBeVisible();
    const stored = await page.evaluate((key) => window.localStorage.getItem(key), DEV_TOKEN_STORAGE_KEY);
    expect(stored).toMatch(/^dev:/);
  });

  test('goes to the start page, on this origin, for a return value that is not a path of the app', async ({ page, baseURL }) => {
    await pointAtApi(page);
    for (const bad of ['//evil.example', 'https://evil.example', '/\\evil.example']) {
      await page.goto(`/login?return=${encodeURIComponent(bad)}`);
      await page.getByLabel('User id').fill('e2e-alice');
      await page.getByLabel('Secret').fill(devSecret());
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page.waitForURL((url) => !url.pathname.startsWith('/login'));
      expect(new URL(page.url()).origin).toBe(new URL(baseURL ?? 'http://127.0.0.1:4173').origin);
      // The start page is the app: with its stored session gone it would send the browser to sign in again (`RequireSignIn`), and that navigation could land in the middle of the next `goto` (WebKit
      // reports it as "interrupted by another navigation"). So the app is signed in and settled first, and left for the inert sign-in document before the storage is cleared.
      await expect(page.getByTestId('user-name')).toBeVisible();
      await page.goto('/login.html');
      await page.evaluate(() => window.localStorage.clear());
    }
  });

  test('a signed-out visit to a page goes to the sign-in document, remembering the page', async ({ page }) => {
    await pointAtApi(page);
    await page.goto('/trash');
    await page.waitForURL(/\/login\?/);
    expect(new URL(page.url()).searchParams.get('return')).toBe('/trash');
  });
});
