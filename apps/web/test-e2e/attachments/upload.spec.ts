import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { makePage } from '../editor/pages';
import { signInAs } from '../support/sign-in';
import { waitForSynced } from '../support/sync';
import { pastePng, storeOrigin } from './real-stack';

/** What the page holds of the image, for the message of a failure (a WebKit run once ended with an image that never loaded and nothing to say why): the state of its box and what its element reports. */
const describeImage = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const box = document.querySelector<HTMLElement>('.attachment-image');
    const img = box?.querySelector('img');
    return JSON.stringify({
      box: box === null ? null : { ...box.dataset },
      img: img === null || img === undefined ? null : { complete: img.complete, naturalWidth: img.naturalWidth, srcOrigin: new URL(img.src, location.href).origin },
    });
  });

// Needs the whole stack with the file store (`make files-setup` done): the `Web browser tests` job.
test('pasting a PNG makes the requests in order (create, PUT to the store, complete), the PUT carries content-type and if-none-match: *, and an image of the store is in the page', async ({ browser, baseURL }) => {
  const made = await makePage('# Upload\n\nText.\n', { permission: 'read_write' });
  const context = await browser.newContext({ ...(baseURL === undefined ? {} : { baseURL }) });
  try {
    await signInAs(context, 'e2e-alice', 'member');
    const page = await context.newPage();
    const seen: string[] = [];
    let putHeaders: Record<string, string> = {};
    const storeAnswers: string[] = []; // the store's answers and the requests that failed, by method and status or error: never the signed address
    const failed: string[] = [];
    page.on('response', (response) => {
      if (new URL(response.url()).origin === storeOrigin()) storeAnswers.push(`${response.request().method()} ${String(response.status())}`);
    });
    page.on('requestfailed', (request) => failed.push(`${request.method()} ${new URL(request.url()).origin} ${request.failure()?.errorText ?? '?'}`));
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
    try {
      await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth), { timeout: 30_000 }).toBeGreaterThan(0);
    } catch (error) {
      throw new Error(
        `the image of the store did not load in 30 s: ${await describeImage(page)}; requests seen: ${seen.join(', ') || 'none'}; the store answered: ${storeAnswers.join(', ') || 'nothing'}; requests that failed: ${failed.join(', ') || 'none'}`,
        { cause: error },
      );
    }
    expect(seen).toEqual(['POST /v1/attachments', 'PUT store', 'POST /v1/attachments/{id}/complete']);
    expect(putHeaders['content-type']).toBe('image/png');
    expect(putHeaders['if-none-match']).toBe('*');
    expect((await img.getAttribute('src'))?.startsWith(`${storeOrigin()}/`), 'the image comes from the store').toBe(true);
  } finally {
    await context.close();
  }
});
