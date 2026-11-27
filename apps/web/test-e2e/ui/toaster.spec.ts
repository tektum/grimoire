import { expect, test } from '@playwright/test';
import { API, mockApi } from '../collections/mock-api';
import { signInAs } from '../support/sign-in';
import { shots } from '../support/shots';

// A notice follows the theme: its background and text are the tokens of the scheme the page is in, in light and in dark. The notice here is the API wrapper's
// words for a refused change (409 `collection_full` on New page). Needs a development build of the client (`bunx vite build --mode e2e`).
const SANS = ":root { --font-ui: 'Liberation Sans', Arial, sans-serif; } [data-sonner-toaster] { font-family: 'Liberation Sans', Arial, sans-serif; }"; // for the pictures only

for (const scheme of ['light', 'dark'] as const) {
  test(`a notice is painted with the tokens of the ${scheme} theme`, async ({ page, context, browserName }) => {
    await signInAs(context, 'e2e-alice', 'member', { check: false });
    await mockApi(page, { collections: [{ id: 'c1', name: 'Dev', myPermission: 'read-write' }], pages: [] });
    await page.route(`${API}/v1/pages`, (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({ status: 409, contentType: 'application/json', headers: { 'access-control-allow-origin': route.request().headers()['origin'] ?? '*' }, body: JSON.stringify({ error: { code: 'collection_full', message: 'x' } }) })
        : route.fallback(),
    );
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto('/c/c1');
    await page.addStyleTag({ content: SANS });
    await expect(page.getByRole('heading', { level: 1, name: 'Dev' })).toBeVisible();
    await page.getByRole('button', { name: 'New page' }).click();
    const notice = page.locator('[data-sonner-toast]').filter({ hasText: 'This collection is full' });
    await expect(notice).toBeVisible();
    // What the tokens are, in this scheme, read back as colours the browser computes.
    const wanted = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.cssText = 'background: var(--paper-raised); color: var(--ink); border-color: var(--hairline)';
      document.body.append(probe);
      const style = getComputedStyle(probe);
      const colours = { background: style.backgroundColor, color: style.color };
      probe.remove();
      return colours;
    });
    const got = await notice.evaluate((el) => ({ background: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color }));
    expect(got).toEqual(wanted);
    await page.mouse.move(0, 0);
    if (browserName === 'chromium') await shots(page, 'M6-T12', 'notice');
  });
}
