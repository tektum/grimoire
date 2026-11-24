import { expect, test } from '@playwright/test';
import { makePage } from '../editor/pages';
import { signInAs } from '../support/sign-in';
import { waitForSynced } from '../support/sync';
import { pastePng, storeOrigin } from './real-stack';

// Needs the whole stack with the file store (`make files-setup` done): the `Web browser tests` job.
test('pasting a PNG makes the requests in order (create, PUT to the store, complete), the PUT carries content-type and if-none-match: *, and an image of the store is in the page', async ({ browser, baseURL }) => {
  const made = await makePage('# Upload\n\nText.\n', { permission: 'read_write' });
  const context = await browser.newContext({ ...(baseURL === undefined ? {} : { baseURL }) });
  try {
    await signInAs(context, 'e2e-alice', 'member');
    const page = await context.newPage();
    const seen: string[] = [];
    let putHeaders: Record<string, string> = {};
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith('/v1/attachments') && request.method() === 'POST' && !url.pathname.endsWith('/urls')) seen.push(`POST ${url.pathname.replace(/[0-9a-f-]{36}/, '{id}')}`);
      if (request.method() === 'PUT' && url.origin === storeOrigin()) {
        seen.push('PUT store');
        putHeaders = request.headers();
      }
    });
    await page.goto(made.path);
    await waitForSynced(page);
    await pastePng(page, 'photo.png');
    const img = page.locator('.attachment-image img');
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth), { timeout: 30_000 }).toBeGreaterThan(0);
    expect(seen).toEqual(['POST /v1/attachments', 'PUT store', 'POST /v1/attachments/{id}/complete']);
    expect(putHeaders['content-type']).toBe('image/png');
    expect(putHeaders['if-none-match']).toBe('*');
    expect((await img.getAttribute('src'))?.startsWith(`${storeOrigin()}/`), 'the image comes from the store').toBe(true);
  } finally {
    await context.close();
  }
});
