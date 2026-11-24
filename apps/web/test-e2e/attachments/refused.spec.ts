import { expect, test } from '@playwright/test';
import { openPage, pasteFiles, scriptStore } from './support';

test.describe('files the server refuses', () => {
  test('a .exe file shows "That file type isn\'t allowed" and leaves no node in the document', async ({ page }) => {
    const store = await scriptStore(page, { createStatus: () => 422 });
    const opened = await openPage(page, 'Text.\n', { editable: true });
    try {
      await pasteFiles(page, [{ name: 'setup.exe', type: 'application/x-msdownload' }]);
      await expect(page.getByText("That file type isn't allowed")).toBeVisible();
      // The notice's close button is inside it (top right) and a 24 px target, not on its corner.
      const toast = page.locator('[data-sonner-toast]').first();
      const close = toast.locator('[data-close-button]');
      const [outer, inner] = [await toast.boundingBox(), await close.boundingBox()];
      expect(inner!.width).toBeGreaterThanOrEqual(24);
      expect(inner!.height).toBeGreaterThanOrEqual(24);
      expect(inner!.x).toBeGreaterThanOrEqual(outer!.x);
      expect(inner!.y).toBeGreaterThanOrEqual(outer!.y);
      expect(inner!.x + inner!.width).toBeLessThanOrEqual(outer!.x + outer!.width);
      expect(store.log).toEqual(['POST /v1/attachments']); // nothing was sent to the store
      expect((await opened.markdown()).trim()).toBe('Text.');
      await expect(page.locator('.attachment-uploading')).toHaveCount(0);
    } finally {
      await opened.stop();
    }
  });

  test('a file one byte over the maximum shows "That file is over 25 MB" (the limit the server announces) and leaves no node', async ({ page }) => {
    await scriptStore(page, { createStatus: () => 413 });
    const opened = await openPage(page, 'Text.\n', { editable: true });
    try {
      await pasteFiles(page, [{ name: 'big.png', type: 'image/png', bytes: 11 }]);
      await expect(page.getByText('That file is over 25 MB')).toBeVisible();
      expect((await opened.markdown()).trim()).toBe('Text.');
      await expect(page.locator('.attachment-uploading')).toHaveCount(0);
    } finally {
      await opened.stop();
    }
  });
});
