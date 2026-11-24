import { expect, test } from '@playwright/test';
import { signInAs } from '../support/sign-in';
import { isRemoteUrl, onHost, pointAtApi, PROVIDER_HOSTS, recordRequests } from './support';

// The identity provider's code and its fingerprinting script load on the sign-in document only. This spec never reaches the provider: every request to a
// host other than the local ones is answered by route interception (aborted), so what it records is what the page asked for, and nothing leaves the machine.
const LOCAL = ['127.0.0.1', 'localhost'];
const isRemote = (url: URL) => !LOCAL.includes(url.hostname);

test.describe('the provider chunk', () => {
  test('a signed-in start makes no request to the provider or its fingerprinting script', async ({ context, page }) => {
    await signInAs(context, 'e2e-alice', 'member');
    await page.route(isRemote, (route) => route.abort());
    await pointAtApi(page);
    const log = recordRequests(page);
    await page.goto('/search');
    await expect(page.getByRole('heading', { level: 1, name: 'Search' })).toBeVisible();
    // Nothing leaves the machine at all: not the provider's hosts, not its fingerprinting script, not anything else.
    expect(log.urls().filter((u) => onHost(u, PROVIDER_HOSTS) || isRemoteUrl(u))).toEqual([]);
    expect(log.urls().filter((u) => /descope|fingerprint/i.test(new URL(u).pathname))).toEqual([]);
  });

  test('on the sign-in document with the provider flow forced (a configuration that is not local, stubbed), the sign-in chunk is requested', async ({ page }) => {
    await page.route(isRemote, (route) => route.abort());
    await pointAtApi(page);
    await page.route('**/v1/config', (route) =>
      route.fulfill({
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({
          collabUrl: 'ws://127.0.0.1:8080/collab',
          minClientVersion: '0.0.0',
          local: false,
          providerProjectId: 'P2examplestubprojectid000000000000',
          providerBaseUrl: null,
          fileStoreOrigin: null,
        }),
      }),
    );
    const log = recordRequests(page);
    await page.goto('/login?flow=descope');
    await page.locator('descope-wc').waitFor({ state: 'attached' });
    expect(log.urls().some((u) => /\/assets\/descope-signin-[^/]+\.js$/.test(new URL(u).pathname))).toBe(true);
  });
});
