import { expect, test } from '@playwright/test';
import { makePage } from '../editor/pages';
import { signInAs } from '../support/sign-in';
import { waitForSynced } from '../support/sync';
import { expectSaved, savedMarkdown } from '../tables/saved';
import { pastePng } from './real-stack';

// Needs the whole stack with the file store (the `Web browser tests` job).
test.describe('what is saved for an image', () => {
  test('after an upload the saved Markdown holds ![name](attachments/<uuid>/<cleaned name>), and a name with spaces and % round-trips', async ({ browser, baseURL }) => {
    const made = await makePage('# Paths\n\nText.\n', { permission: 'read_write' });
    const context = await browser.newContext({ ...(baseURL === undefined ? {} : { baseURL }) });
    try {
      await signInAs(context, 'e2e-alice', 'member');
      const page = await context.newPage();
      await page.goto(made.path);
      await waitForSynced(page);
      await pastePng(page, '100% plan v2.png');
      await expect(page.locator('.attachment-image[data-state="ready"]')).toHaveCount(1, { timeout: 30_000 });
      await expectSaved(made.id, '![100% plan v2.png](attachments/');
      const saved = await savedMarkdown(made.id);
      expect(saved).toMatch(/!\[100% plan v2\.png\]\(attachments\/[0-9a-f-]{36}\/[^/)\s]+\)/);
      // The page, opened again, shows the same image from that saved path.
      await page.reload();
      await waitForSynced(page);
      await expect(page.locator('.attachment-image[data-state="ready"]')).toHaveCount(1, { timeout: 30_000 });
    } finally {
      await context.close();
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
