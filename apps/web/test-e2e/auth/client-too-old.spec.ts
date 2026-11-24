import { expect, test } from '@playwright/test';
import { parseVersion } from '@tektum/grimoire-core/version';
import { apiUrl } from '../support/env';
import { pointAtApi } from './support';

// With the stack started with M6_MIN_CLIENT_VERSION=99.0.0 (compose.m6.yaml) the app shows the reload text on the gate and nothing else; with the default
// 0.0.0 the same page loads. The expectation is read from the server's own answer, so the same spec is right for both settings of the stack.
test.describe('a client that is too old', () => {
  test('the gate shows the reload text when the server asks for a newer client, and the app loads when it does not', async ({ page }) => {
    const config = (await (await page.request.get(`${apiUrl()}/v1/config`)).json()) as { minClientVersion: string };
    const min = parseVersion(config.minClientVersion);
    expect(min).not.toBeNull();
    await pointAtApi(page);
    await page.goto('/search');
    if (min![0] > 0) {
      await expect(page.getByText('A new version is available. Reload.')).toBeVisible();
      expect(await page.locator('body').innerText()).toBe('A new version is available. Reload.');
    } else {
      await page.waitForURL(/\/login\?|\/search$/);
      await expect(page.getByText('A new version is available. Reload.')).toHaveCount(0);
    }
  });

  test('a configuration that asks for a newer client than this one shows only the reload text (stubbed)', async ({ page }) => {
    await pointAtApi(page);
    await page.route('**/v1/config', (route) =>
      route.fulfill({
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ collabUrl: 'ws://127.0.0.1:8080/collab', minClientVersion: '99.0.0', local: true, providerProjectId: null, providerBaseUrl: null, fileStoreOrigin: null }),
      }),
    );
    await page.goto('/search');
    await expect(page.getByText('A new version is available. Reload.')).toBeVisible();
    expect(await page.locator('body').innerText()).toBe('A new version is available. Reload.');
  });
});
