import { expect, test } from '@playwright/test';
import { UPLOADED_ID, xssCorpus } from '../../test/corpus/xss';
import { FILES, ID, logRequests, openPage, scriptStore } from './support';

// Every Markdown image of the shared hostile corpus, each on a page of its own, by the rule of its entry (contracts section 8, rule 4): an image that is not an uploaded file is
// never loaded (no request for it, whatever the address) and says so; an uploaded one is shown through a signed link. The images of pasted HTML (`html-image-remote`) belong to the
// paste sanitiser, whose work comes with its own spec.
const entries = xssCorpus.filter((e) => (e.expect === 'image-blocked' || e.expect === 'image-kept') && e.markdown !== undefined);
const addressOf = (markdown: string): { alt: string; address: string } => {
  const found = /^!\[([^\]]*)\]\(([^)\s]+)\)$/.exec(markdown);
  if (found === null) throw new Error(`not a lone Markdown image: ${markdown}`);
  return { alt: found[1] ?? '', address: found[2] ?? '' };
};

test('the corpus has image entries of every kind, and the uploaded one is the file the specs answer for', () => {
  expect(UPLOADED_ID).toBe(ID);
  const addresses = entries.map((e) => addressOf(e.markdown ?? '').address);
  expect(addresses.some((a) => a.startsWith('https://'))).toBe(true);
  expect(addresses.some((a) => a.startsWith('//'))).toBe(true);
  expect(addresses.some((a) => a.startsWith('data:'))).toBe(true);
  expect(addresses.some((a) => a.startsWith('./'))).toBe(true);
  expect(entries.some((e) => e.expect === 'image-kept')).toBe(true);
});

for (const entry of entries) {
  test(`${entry.id}: ${entry.expect === 'image-kept' ? 'shown through a signed link' : 'never loaded, and says so'}`, async ({ page }) => {
    const { alt, address } = addressOf(entry.markdown ?? '');
    const store = await scriptStore(page);
    const requests = logRequests(page);
    const opened = await openPage(page, `${entry.markdown ?? ''}\n`);
    try {
      if (entry.expect === 'image-kept') {
        await expect(page.locator('.attachment-image[data-state="ready"]')).toHaveCount(1);
        await expect(page.locator('.attachment-image img')).toHaveAttribute('src', new RegExp(`^${FILES}/${UPLOADED_ID}`));
        expect(store.posted.flat()).toEqual([UPLOADED_ID]);
        return;
      }
      if (address.startsWith('data:')) {
        await expect(page.locator('.page-editor')).toContainText(alt); // the text stands in
      } else {
        const host = address.startsWith('//') || /^https?:/.test(address) ? new URL(address.startsWith('//') ? `https:${address}` : address).hostname : address;
        await expect(page.locator('.attachment-image[data-state="external"]')).toHaveText(`External image not loaded: ${host}`);
        await page.waitForTimeout(300); // a late request, if any, has had its chance
        expect(requests.filter((r) => r.includes(host.replace(/^\.\//, '')))).toEqual([]);
      }
      await expect(page.locator('.page-editor img:not(.ProseMirror-separator)')).toHaveCount(0);
      expect(requests.filter((r) => r.startsWith('GET data:'))).toEqual([]);
      expect(store.posted).toEqual([]); // nothing was asked of the application for it either
    } finally {
      await opened.stop();
    }
  });
}
