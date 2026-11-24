import { expect, test } from '@playwright/test';
import { openPage, pasteFiles, scriptStore } from './support';

test.describe('upload, on a scripted server', () => {
  test('pasting a PNG makes the requests in order (create, PUT to the store origin, complete); the PUT carries content-type and if-none-match: *; an image of the store is in the page', async ({ page }) => {
    const store = await scriptStore(page);
    const opened = await openPage(page, 'Text.\n', { editable: true });
    try {
      await pasteFiles(page, [{ name: 'photo.png', type: 'image/png' }]);
      const img = page.locator('.attachment-image img');
      await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
      expect(store.log.slice(0, 3)).toEqual(['POST /v1/attachments', 'PUT http://files.test/put/00000000-0000-4000-8000-000000000001', 'POST /v1/attachments/00000000-0000-4000-8000-000000000001/complete']);
      expect(store.puts[0]).toMatchObject({ 'content-type': 'image/png', 'if-none-match': '*' });
      expect(await img.getAttribute('src')).toMatch(/^http:\/\/files\.test\//);
    } finally {
      await opened.stop();
    }
  });

  test('the Markdown holds ![name](attachments/<uuid>/<cleaned name>) for an image, and a link for another file; a name with spaces and % round-trips', async ({ page }) => {
    await scriptStore(page);
    const opened = await openPage(page, 'Text.\n', { editable: true });
    try {
      await pasteFiles(page, [{ name: '100% plan v2.png', type: 'image/png' }, { name: 'notes b.pdf', type: 'application/pdf' }]);
      await expect(page.locator('.attachment-image')).toHaveCount(1);
      await expect.poll(() => opened.markdown()).toContain('![100% plan v2.png](attachments/00000000-0000-4000-8000-000000000001/100%25%20plan%20v2.png)');
      expect(await opened.markdown()).toContain('[notes b.pdf](attachments/00000000-0000-4000-8000-000000000002/notes%20b.pdf)');
    } finally {
      await opened.stop();
    }
  });

  test('shows that an upload is in progress until the store has the bytes', async ({ page }) => {
    let release: () => void = () => undefined;
    await scriptStore(page, { holdPut: new Promise<void>((resolve) => { release = resolve; }) });
    const opened = await openPage(page, 'Text.\n', { editable: true });
    try {
      await pasteFiles(page, [{ name: 'photo.png', type: 'image/png' }]);
      await expect(page.locator('.attachment-uploading')).toHaveText('Uploading…');
      release();
      await expect(page.locator('.attachment-uploading')).toHaveCount(0);
      await expect(page.locator('.attachment-image')).toHaveCount(1);
    } finally {
      await opened.stop();
    }
  });
});
