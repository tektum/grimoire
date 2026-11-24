import { expect, test } from '@playwright/test';
import { openPage, pasteFiles, scriptStore } from './support';

test.describe('files the server refuses', () => {
  test('a .exe file shows "That file type isn\'t allowed" and leaves no node in the document', async ({ page }) => {
    const store = await scriptStore(page, { createStatus: () => 422 });
    const opened = await openPage(page, 'Text.\n', { editable: true });
    try {
      await pasteFiles(page, [{ name: 'setup.exe', type: 'application/x-msdownload' }]);
      await expect(page.getByText("That file type isn't allowed")).toBeVisible();
      expect(store.log).toEqual(['POST /v1/attachments']); // nothing was sent to the store
      expect((await opened.markdown()).trim()).toBe('Text.');
      await expect(page.locator('.attachment-uploading')).toHaveCount(0);
    } finally {
      await opened.stop();
    }
  });

  test('a file one byte over the maximum shows "That file is too large" and leaves no node', async ({ page }) => {
    await scriptStore(page, { createStatus: () => 413 });
    const opened = await openPage(page, 'Text.\n', { editable: true });
    try {
      await pasteFiles(page, [{ name: 'big.png', type: 'image/png', bytes: 11 }]);
      await expect(page.getByText('That file is too large')).toBeVisible();
      expect((await opened.markdown()).trim()).toBe('Text.');
      await expect(page.locator('.attachment-uploading')).toHaveCount(0);
    } finally {
      await opened.stop();
    }
  });
});
