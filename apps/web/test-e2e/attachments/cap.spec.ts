import { expect, test } from '@playwright/test';
import { openPage, pasteFiles, scriptStore } from './support';

test('the eleventh parallel upload shows "Too many uploads at once (10 is the most). Wait a moment.", no node is left for it, and the first ten complete', async ({ page }) => {
  const store = await scriptStore(page, { createStatus: (n) => (n === 11 || n > 11 ? 429 : 201) });
  const opened = await openPage(page, 'Text.\n', { editable: true });
  try {
    await pasteFiles(page, Array.from({ length: 11 }, (_, i) => ({ name: `p${i + 1}.png`, type: 'image/png' })));
    await expect(page.getByText('Too many uploads at once (10 is the most). Wait a moment.').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.attachment-image')).toHaveCount(10);
    expect(store.log.filter((l) => l.startsWith('PUT')), 'the first ten were stored').toHaveLength(10);
    expect(store.log.filter((l) => l.endsWith('/complete')), 'and completed').toHaveLength(10);
    await expect(page.locator('.attachment-uploading')).toHaveCount(0);
    const markdown = await opened.markdown();
    expect(markdown.match(/!\[/g)).toHaveLength(10);
  } finally {
    await opened.stop();
  }
});
