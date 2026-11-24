import { expect, test } from '@playwright/test';
import { bundleHarness } from '../collections/bundle';
import { fixtureServer } from '../support/fixtures';
import { shots } from '../support/shots';

const RAW = '<img src=x onerror="window.__pwned=1">';
const MARKDOWN = `A page with a line of raw HTML below.\n\n${RAW}\n\nAnd the text after it.\n`;

test.describe('raw HTML in a page', () => {
  test('is escaped text in a non-editable block with an "Edit source" button, and runs nothing', async ({ page, browserName }) => {
    const bundle = await bundleHarness('../safety/raw-html-harness.tsx');
    const server = await fixtureServer({ '/': '<!doctype html><meta charset="utf-8"><title>Grimoire</title><div id="host"></div>' });
    try {
      const dialogs: string[] = [];
      const requests: string[] = [];
      page.on('dialog', (d) => { dialogs.push(d.message()); void d.dismiss(); });
      page.on('request', (r) => requests.push(r.url()));
      await page.goto(server.url(`/?md=${encodeURIComponent(MARKDOWN)}`));
      await page.addStyleTag({ content: bundle.css });
      await page.addScriptTag({ content: bundle.js });
      await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true);

      const block = page.locator('.ProseMirror .raw-html');
      await expect(block).toHaveCount(1);
      await expect(block).toHaveAttribute('contenteditable', 'false');
      await expect(block.locator('code')).toHaveText(RAW);
      await expect(block.getByRole('button', { name: 'Edit source' })).toBeVisible();
      await expect(page.locator('.ProseMirror img:not(.ProseMirror-separator)')).toHaveCount(0);
      expect(await page.evaluate(() => (window as unknown as { __pwned?: unknown }).__pwned)).toBeUndefined();
      expect(dialogs).toEqual([]);
      expect(requests.filter((u) => !u.startsWith(server.url('/')) && !u.startsWith('data:') && !u.startsWith('blob:'))).toEqual([]);
      expect(requests.some((u) => u.endsWith('/x'))).toBe(false);

      if (browserName === 'chromium') await shots(page, 'm6-t11', 'raw-html-block');

      await block.getByRole('button', { name: 'Edit source' }).click();
      await expect(page.locator('.ProseMirror .raw-html')).toHaveCount(0);
      await expect(page.locator('.ProseMirror')).toContainText(RAW);
    } finally {
      await server.stop();
    }
  });
});
