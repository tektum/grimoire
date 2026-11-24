import { expect, test } from '@playwright/test';
import { ID, logRequests, openPage, scriptStore } from './support';

test.describe('images that are not uploaded files', () => {
  test('a web address renders the placeholder with its host, and no request is made to that host', async ({ page }) => {
    await scriptStore(page);
    await page.route('**evil.test/**', (route) => route.abort());
    const requests = logRequests(page);
    const opened = await openPage(page, '![x](https://evil.test/p.png)\n');
    try {
      await expect(page.locator('.attachment-image')).toHaveText('External image not loaded: evil.test');
      await page.waitForTimeout(300);
      expect(requests.filter((r) => r.includes('evil.test'))).toEqual([]);
      await expect(page.locator('.attachment-image img')).toHaveCount(0);
    } finally {
      await opened.stop();
    }
  });

  test('a data: address is never turned into an image: the text stands in, and nothing is requested for it', async ({ page }) => {
    await scriptStore(page);
    const requests = logRequests(page);
    const opened = await openPage(page, '![the alt text](data:image/png;base64,iVBORw0KGgo=)\n');
    try {
      await expect(page.locator('.page-editor')).toContainText('the alt text');
      await expect(page.locator('.page-editor img:not(.ProseMirror-separator)')).toHaveCount(0);
      expect(requests.filter((r) => r.startsWith('GET data:'))).toEqual([]);
    } finally {
      await opened.stop();
    }
  });

  test('a relative address that is not an attachment (./x.png) renders the placeholder and makes no request to the app origin for it', async ({ page }) => {
    await scriptStore(page);
    const requests = logRequests(page);
    const opened = await openPage(page, '![x](./x.png)\n');
    try {
      await expect(page.locator('.attachment-image')).toHaveText('External image not loaded: ./x.png');
      await page.waitForTimeout(300);
      expect(requests.filter((r) => r.includes('/x.png'))).toEqual([]);
    } finally {
      await opened.stop();
    }
  });

  test('an uploaded file next to them still loads', async ({ page }) => {
    await scriptStore(page);
    const opened = await openPage(page, `![x](https://evil.test/p.png)\n\n![mine](attachments/${ID}/mine.png)\n`);
    try {
      await expect(page.locator('.attachment-image[data-state="ready"]')).toHaveCount(1);
      await expect(page.locator('.attachment-image[data-state="external"]')).toHaveCount(1);
    } finally {
      await opened.stop();
    }
  });
});
