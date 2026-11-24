import { expect, test } from '@playwright/test';
import { isSafeHref } from '../../src/safety';
import { xssCorpus } from '../../test/corpus/xss';
import { signInAs } from '../support/sign-in';
import { historyApi, SLUG } from './mock-api';

// A version's stored Markdown is drawn by the rules of contracts section 8 (rule 1: links, by `isSafeHref`, which the editor's own link guard applies in the read-only
// editor this screen uses; rule 2: raw HTML is inert text): every link entry and every
// HTML entry of the corpus is in one version, and the screen has no `<a>` with an unsafe address, runs no script, opens no dialog and fetches nothing from another host.
// Images (rule 4) are the image node view's rule, not this screen's: the entries for them are left out here.
const entries = xssCorpus.filter((e) => e.expect !== 'bounded' && e.expect !== 'image-blocked' && e.expect !== 'image-kept');
const text = entries.map((e) => e.markdown ?? e.html ?? '').filter((t) => t !== '').join('\n\n');

test('the corpus links and HTML in a version draw no unsafe link, run no script and fetch nothing from elsewhere', async ({ page, context }) => {
  await signInAs(context, 'e2e-alice', 'member', { check: false });
  const api = await historyApi(page, {
    role: 'member',
    current: '# Plan\n',
    revisions: [{ id: 'r1', createdAt: Date.UTC(2026, 10, 20, 14, 30), title: 'Quarterly plan', reason: 'idle', lastAuthor: { id: 'u1', name: 'Alice Example' }, authors: [{ id: 'u1', name: 'Alice Example' }], markdown: text }],
  });
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => { dialogs.push(dialog.message()); void dialog.dismiss(); });
  await page.goto(`/p/${SLUG}/history/r1`);
  await expect(page.getByTestId('revision-text').locator('.ProseMirror')).toBeVisible();
  await page.waitForTimeout(500); // late handlers, if any, have had their chance
  const hrefs = await page.getByTestId('revision-text').locator('a[href]').evaluateAll((links) => links.map((a) => a.getAttribute('href') ?? ''));
  expect(hrefs.length).toBeGreaterThan(0); // the safe links are drawn, so this is not a page without links
  expect(hrefs.filter((h) => !isSafeHref(h))).toEqual([]);
  // Every safe link of the corpus is there as a link and no other is: the refused ones were never drawn as links (the text stays), so the test did not pass on a page without links.
  expect(hrefs).toHaveLength(entries.filter((e) => e.expect === 'link-kept' && e.markdown !== undefined).length);
  expect(dialogs).toEqual([]);
  expect(await page.evaluate(() => Object.keys(window).filter((k) => /hack|pwn/i.test(k)))).toEqual([]);
  expect(api.foreign).toEqual([]);
  expect(await page.getByTestId('revision-text').locator('script, iframe, object, embed, form, style, img[src^="http"]').count()).toBe(0);
});
