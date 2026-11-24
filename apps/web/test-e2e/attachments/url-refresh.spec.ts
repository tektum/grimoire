import { expect, test } from '@playwright/test';
import { ID, logRequests, openPage, scriptStore } from './support';

test.describe('signed links of images', () => {
  test('an expired link (the store answers 403 once) is refreshed with one more POST /v1/attachments/urls, and the image loads without a reload', async ({ page }) => {
    const store = await scriptStore(page, { refuse403: new Set([ID]) });
    const requests = logRequests(page);
    const opened = await openPage(page, `![a photo](attachments/${ID}/photo.png)\n`);
    try {
      const img = page.locator('.attachment-image img');
      await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
      expect(store.posted, 'one POST for the first link, one more for the refresh').toEqual([[ID], [ID]]);
      expect(store.served).toHaveLength(2); // the refused one, then the new link
      expect(requests.filter((r) => r.startsWith('GET') && r.endsWith('/'))).toHaveLength(1); // the page itself was loaded once: no reload
      await expect(page.locator('.attachment-image')).toHaveAttribute('data-state', 'ready');
    } finally {
      await opened.stop();
    }
  });

  test('the images of a page that load together are asked for in one request', async ({ page }) => {
    const store = await scriptStore(page);
    const second = '5a6b7c8d-1e2f-4a3b-9c4d-5e6f7a8b9c0d';
    const opened = await openPage(page, `![one](attachments/${ID}/a.png)\n\n![two](attachments/${second}/b.png)\n`);
    try {
      await expect(page.locator('.attachment-image[data-state="ready"]')).toHaveCount(2);
      expect(store.posted).toEqual([[ID, second]]);
    } finally {
      await opened.stop();
    }
  });
});
