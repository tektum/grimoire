import { expect, test } from '@playwright/test';
import { shots } from '../support/shots';
import { ID, openPage, pasteFiles, scriptStore } from './support';

// Screenshots (test-results/shots/M6-T08/): the page's own styles and the real node view; the pictures are drawn by the spec (a vector image served as the file).
const TASK = 'M6-T08';
const PICTURE = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270" viewBox="0 0 480 270"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2e6f6a"/><stop offset="1" stop-color="#d9a441"/></linearGradient></defs><rect width="480" height="270" rx="10" fill="url(#g)"/><circle cx="360" cy="80" r="34" fill="#f7efd8"/><path d="M0 270 L150 120 L250 210 L330 150 L480 270 Z" fill="#1d3b3a" opacity=".85"/></svg>`;

test.beforeEach(({ browserName }) => { test.skip(browserName !== 'chromium', 'screenshots are taken once, in Chromium'); });

test('an image in a page, light and dark', async ({ page }) => {
  await scriptStore(page, { image: { type: 'image/svg+xml', body: PICTURE } });
  const opened = await openPage(page, `# Trip notes\n\nThe ridge at sunset, from the second camp.\n\n![The ridge at sunset](attachments/${ID}/ridge.png)\n\nWe left at dawn the next day.\n`, { sans: true });
  try {
    await expect(page.locator('.attachment-image[data-state="ready"]')).toHaveCount(1);
    await shots(page, TASK, 'image');
  } finally {
    await opened.stop();
  }
});

test('the "External image not loaded" placeholder, light and dark', async ({ page }) => {
  await scriptStore(page);
  const opened = await openPage(page, '# Trip notes\n\nA picture from somewhere else:\n\n![A picture from another site](https://photos.example.com/p.png)\n\nThe text goes on.\n', { sans: true });
  try {
    await expect(page.locator('.attachment-image[data-state="external"]')).toHaveCount(1);
    await shots(page, TASK, 'external-image');
  } finally {
    await opened.stop();
  }
});

test('an attachment link, light and dark', async ({ page }) => {
  await scriptStore(page);
  const opened = await openPage(page, `# Trip notes\n\nThe route and the budget are in the files: [route-plan.pdf](attachments/${ID}/route-plan.pdf) and [budget.xlsx](attachments/${ID}/budget.xlsx).\n`, { sans: true });
  try {
    await expect(page.locator(`a[href="attachments/${ID}/route-plan.pdf"]`)).toBeVisible();
    await shots(page, TASK, 'attachment-link');
  } finally {
    await opened.stop();
  }
});

test('an upload in progress, light and dark', async ({ page }) => {
  let release: () => void = () => undefined;
  await scriptStore(page, { holdPut: new Promise<void>((resolve) => { release = resolve; }) });
  const opened = await openPage(page, '# Trip notes\n\nThe ridge at sunset, from the second camp:\n\n', { sans: true, editable: true });
  try {
    await pasteFiles(page, [{ name: 'ridge.png', type: 'image/png' }]);
    await expect(page.locator('.attachment-uploading')).toBeVisible();
    await shots(page, TASK, 'upload-in-progress');
    release();
  } finally {
    await opened.stop();
  }
});

for (const [name, text, options, files] of [
  ['refused-type', "That file type isn't allowed", { createStatus: () => 422 }, [{ name: 'setup.exe', type: 'application/x-msdownload' }]],
  ['refused-size', 'That file is too large', { createStatus: () => 413 }, [{ name: 'video.png', type: 'image/png' }]],
  ['refused-cap', 'Too many uploads at once. Wait a moment.', { createStatus: () => 429 }, [{ name: 'photo.png', type: 'image/png' }]],
] as const) {
  test(`the refusal "${text}", light and dark`, async ({ page }) => {
    await scriptStore(page, options);
    const opened = await openPage(page, '# Trip notes\n\nThe ridge at sunset, from the second camp.\n', { sans: true, editable: true });
    try {
      await pasteFiles(page, [...files]);
      await expect(page.getByText(text).first()).toBeVisible({ timeout: 20_000 });
      await shots(page, TASK, name);
    } finally {
      await opened.stop();
    }
  });
}
