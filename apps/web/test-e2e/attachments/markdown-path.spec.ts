import { expect, test } from '@playwright/test';
import { makePage } from '../editor/pages';
import { signInAs } from '../support/sign-in';
import { waitForSynced } from '../support/sync';
import { expectSaved, savedMarkdown } from '../tables/saved';
import { pastePng } from './real-stack';

// Needs the whole stack with the file store (the `Web browser tests` job).
test.describe('what is saved for an image', () => {
  test('after an upload the saved Markdown holds ![name](attachments/<uuid>/<cleaned name>), and a name with spaces and % round-trips', async ({ context, page }) => {
    const made = await makePage('# Paths\n\nText.\n', { permission: 'read_write' });
    // What the page said and asked for after the reload, kept for the failure report: on WebKit the image once stayed out of `ready` for the whole 30 seconds, and a closed context left nothing to look at.
    const seen: string[] = [];
    page.on('console', (message) => message.type() !== 'log' && message.type() !== 'debug' && seen.push(`console.${message.type()}: ${message.text().slice(0, 200)}`));
    page.on('pageerror', (error) => seen.push(`pageerror: ${error.message.slice(0, 200)}`));
    page.on('requestfailed', (request) => seen.push(`requestfailed: ${request.method()} ${new URL(request.url()).pathname} ${request.failure()?.errorText ?? ''}`));
    page.on('response', (response) => response.status() >= 400 && seen.push(`response ${String(response.status())}: ${response.request().method()} ${new URL(response.url()).pathname}`));
    await signInAs(context, 'e2e-alice', 'member');
    await page.goto(made.path);
    await waitForSynced(page);
    await pastePng(page, '100% plan v2.png');
    await expect(page.locator('.attachment-image[data-state="ready"]')).toHaveCount(1, { timeout: 30_000 });
    await expectSaved(made.id, '![100% plan v2.png](attachments/');
    const saved = await savedMarkdown(made.id);
    expect(saved).toMatch(/!\[100% plan v2\.png\]\(attachments\/[0-9a-f-]{36}\/[^/)\s]+\)/);
    // The page, opened again, shows the same image from that saved path.
    seen.length = 0;
    await page.reload();
    await waitForSynced(page);
    try {
      await expect(page.locator('.attachment-image[data-state="ready"]')).toHaveCount(1, { timeout: 30_000 });
    } catch (error) {
      const states = await page
        .locator('.attachment-image')
        .evaluateAll((nodes) =>
          nodes.map(
            (n) =>
              `${n.getAttribute('data-state') ?? '-'}: ${(n.textContent ?? '').slice(0, 60)} img=${n.querySelector('img')?.getAttribute('src')?.split('?')[0] ?? 'none'} complete=${String((n.querySelector('img') as HTMLImageElement | null)?.complete)}`,
          ),
        );
      await test.info().attach('after-reload.txt', { body: JSON.stringify({ states, seen, markdown: saved.slice(0, 300) }, null, 2), contentType: 'text/plain' });
      throw error;
    }
  });

  test('a Markdown image with the relative address ./x.png renders the placeholder and makes no request to the app origin for it', async ({ browser, baseURL }) => {
    const made = await makePage('# Relative\n\n![x](./x.png)\n', { permission: 'read_write' });
    const context = await browser.newContext({ ...(baseURL === undefined ? {} : { baseURL }) });
    try {
      await signInAs(context, 'e2e-alice', 'member');
      const page = await context.newPage();
      const requests: string[] = [];
      page.on('request', (request) => requests.push(request.url()));
      await page.goto(made.path);
      await waitForSynced(page);
      await expect(page.locator('.attachment-image[data-state="external"]')).toHaveText('External image not loaded: ./x.png');
      expect(requests.filter((url) => url.endsWith('/x.png'))).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
