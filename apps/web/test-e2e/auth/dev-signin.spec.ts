import { expect, test } from '@playwright/test';
import { devSecret } from '../support/env';
import { apiUrl } from '../support/env';
import { pointAtApi, recordRequests } from './support';

// The development sign-in against the stack (`make up` with compose.m6.yaml, local mode) and a development or test build of the client
// (`bunx vite build --mode e2e` in apps/web). The secret comes from the test environment (`E2E_DEV_TOKEN_SECRET`, or .env) and is never printed.
const BEARER = /^Bearer dev:[A-Za-z0-9_-]{16,128}:[a-z0-9_-]{1,64}:(admin|member|viewer)$/;

async function signInThroughTheForm(page: import('@playwright/test').Page, userId: string, role: string, secret = devSecret()) {
  await pointAtApi(page);
  await page.goto('/login?return=%2Fsearch');
  await page.getByLabel('User id').fill(userId);
  await page.getByLabel('Role').selectOption(role);
  await page.getByLabel('Secret').fill(secret);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test.describe('development sign-in', () => {
  test('signs in alice as member: GET /v1/me returns her, with a bearer of the right shape and no cookie', async ({ page }) => {
    const log = recordRequests(page);
    await signInThroughTheForm(page, 'e2e-alice', 'member');
    await expect(page).toHaveURL(/\/search$/);
    await expect(page.getByTestId('user-name')).toBeVisible();
    const me = log.all().filter((r) => r.url() === `${apiUrl()}/v1/me`);
    expect(me.length).toBeGreaterThan(0);
    for (const request of me) {
      const headers = await request.allHeaders();
      // The shape is compared with a pattern: the secret is never printed.
      expect(BEARER.test(headers['authorization'] ?? '')).toBe(true);
      expect(headers['authorization']).toContain(':e2e-alice:member');
      expect('cookie' in headers).toBe(false);
    }
    const body = await (await page.request.get(`${apiUrl()}/v1/me`, { headers: { Authorization: `Bearer dev:${devSecret()}:e2e-alice:member` } })).json();
    expect(body).toMatchObject({ email: 'e2e-alice@dev.invalid', role: 'member' });
  });

  test('shows a viewer as read-only', async ({ page }) => {
    await signInThroughTheForm(page, 'e2e-vera', 'viewer');
    await expect(page.getByTestId('user-role')).toHaveText('viewer (read-only)');
  });

  test('refuses a bad user id and a short secret with the form text, before any request to the API', async ({ page }) => {
    const log = recordRequests(page);
    await pointAtApi(page);
    await page.goto('/login');
    await page.getByLabel('User id').fill('Alice');
    await page.getByLabel('Secret').fill(devSecret());
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toHaveText('The user id is 1 to 64 lowercase letters, digits, - or _.');
    await page.getByLabel('User id').fill('alice');
    await page.getByLabel('Secret').fill('short');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toContainText('The secret is 16 to 128');
    expect(log.urls().filter((u) => u.startsWith(`${apiUrl()}/v1/me`))).toEqual([]);
  });

  test('says the server did not accept a wrong secret, and does not print it', async ({ page }) => {
    await signInThroughTheForm(page, 'e2e-alice', 'member', 'x'.repeat(32));
    await expect(page.getByRole('alert')).toHaveText('The server did not accept that user id and secret.');
    expect(await page.locator('body').innerText()).not.toContain('x'.repeat(32));
  });
});
