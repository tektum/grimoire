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

  test("a start with a provider session loads the SDK as a chunk of the app's own origin, and no script, style, font or frame from anywhere else", async ({ page }) => {
    // The decision is that the provider's third-party scripts run on the sign-in document only. The app's refresh of a session needs the SDK itself (an own-origin
    // chunk, requested only when a session exists), whose calls are to the provider's API; this pins that nothing else of the provider's comes along.
    // Each remote request, with the document it came from at that moment: the app's own, or the sign-in document the browser is sent to afterwards.
    const remote: { host: string; type: string; from: string }[] = [];
    page.on('request', (request) => {
      if (isRemoteUrl(request.url())) remote.push({ host: new URL(request.url()).hostname, type: request.resourceType(), from: new URL(request.frame().url()).pathname });
    });
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
    await page.addInitScript(() => {
      window.localStorage.setItem('DSR', 'refresh-token-of-a-stub');
      window.localStorage.setItem('DS', 'session-token-of-a-stub');
    });
    const log = recordRequests(page);
    await page.goto('/search');
    await expect.poll(() => log.urls().some((u) => /\/assets\/descope-sdk-[^/]+\.js$/.test(new URL(u).pathname))).toBe(true);
    await page.waitForURL(/\/login\?/); // the stubbed refresh cannot succeed: the session ends and the browser goes to the sign-in document
    // From the app's document the SDK makes calls to the provider's API (the refresh) and loads nothing: no script, style, font, image or frame of the provider's.
    const fromApp = remote.filter((r) => !r.from.startsWith('/login'));
    expect(fromApp.length).toBeGreaterThan(0); // the refresh was attempted, so this is a measurement and not an empty list
    expect(fromApp.filter((r) => !['fetch', 'xhr'].includes(r.type) || !r.host.startsWith('api.'))).toEqual([]);
  });
});
