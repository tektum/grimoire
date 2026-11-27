import { expect, test } from '@playwright/test';
import { shots } from '../support/shots';
import { SAVED_PAGE, openShots, p, settled, settledScreen } from '../page/shot-support';
import { hit, scriptedSearch } from './support';

// The palette and the search screen, light and dark, 1280 by 800 (test-results/shots/M6-T09/): the palette open over a page, with results and one match highlighted by `mark`; the screen with results, a passage line and the partial notice; the screen with no results. Against the stand-in of the API and a scripted search (see
// `page/shot-support.ts` for the editor's collaboration server and the font). Run by the same command as the other browser tests.
const TASK = 'M6-T09';

test('the palette open with results, one match highlighted', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'screenshots are taken once, in Chromium');
  await openShots(page, context, [p(SAVED_PAGE.id, null, 'p0000', 'Plan', SAVED_PAGE.urlId), p('b', null, 'p0001', 'Meeting notes'), p('c', null, 'p0002', 'Product roadmap')]);
  await scriptedSearch(page, () => ({
    items: [
      hit('r1', 'r1000000', 'Product roadmap', 'The roadmap for the next quarter: search first, then import, then files.', [[4, 11]]),
      hit('r2', 'r2000000', 'Release checklist', 'Before each release, check the roadmap and the open questions.', [[31, 38]]),
      hit('r3', 'r3000000', 'Quarterly planning', 'Goals for the quarter and what the roadmap leaves out.', [[35, 42]]),
    ],
  }));
  await page.goto(`/p/plan-${SAVED_PAGE.urlId}`);
  await settled(page, 3);
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox').fill('roadmap');
  await expect(
    // The result row, in its group: the page of the same name is also offered above it as a Pages row, which has no snippet.
    page
      .getByRole('group', { name: 'Search results' })
      .getByRole('option', { name: /Product roadmap/ })
      .first()
      .locator('mark'),
  ).toHaveText('roadmap');
  await expect(page.getByRole('option', { name: /Release checklist/ })).toBeVisible();
  await shots(page, TASK, 'palette');
});

test('the search screen with results, a passage line and the partial notice', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'screenshots are taken once, in Chromium');
  await openShots(page, context, [p('a', null, 'p0000', 'Quarterly planning'), p('b', null, 'p0001', 'Meeting notes')]);
  await scriptedSearch(page, () => ({
    items: [
      hit('r1', 'r1000000', 'Product roadmap', 'The roadmap for the next quarter: search first, then import, then files.', [[4, 11]], {
        matchedPassage: { text: 'Search comes before import because every later piece, the importer included, reads pages through it and checks what it finds.' },
      }),
      hit('r2', 'r2000000', 'Release checklist', 'Before each release, check the roadmap and the open questions.', [[31, 38]]),
      hit('r3', 'r3000000', 'Handbook (all chapters)', 'The roadmap of the handbook is in the first chapter, with the owners.', [[4, 11]], { partial: true }),
    ],
  }));
  await page.goto('/search?q=roadmap');
  await expect(page.getByRole('link', { name: 'Product roadmap' })).toBeVisible();
  await settledScreen(page);
  await shots(page, TASK, 'screen');
});

test('the search screen with no results', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'screenshots are taken once, in Chromium');
  await openShots(page, context, [p('a', null, 'p0000', 'Quarterly planning')]);
  await scriptedSearch(page, () => ({ items: [] }));
  await page.goto('/search?q=zebra');
  await expect(page.getByText('No results')).toBeVisible();
  await settledScreen(page);
  await shots(page, TASK, 'no-results');
});
