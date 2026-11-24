import { expect, test } from '@playwright/test';
import { shots } from '../support/shots';
import { EMPTY_PAGE, SAVED_PAGE, openShots, p, settled } from './shot-support';

// The title of a page, edited in place, light and dark, 1280 by 800 (test-results/shots/M6-TITLE/): the title as the button it is, the field with the title in it, and the field of a new page.
// Against a stand-in of the API (see `shot-support.ts` for the editor's collaboration server and the font). Run by the same command as the other browser tests.
const TASK = 'M6-TITLE';

test('the title of a page: the button, and the field with the title', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'screenshots are taken once, in Chromium');
  await openShots(page, context, [p(SAVED_PAGE.id, null, 'p0000', 'Plan', SAVED_PAGE.urlId), p('b', null, 'p0001', 'Meeting notes')]);
  await page.goto(`/p/plan-${SAVED_PAGE.urlId}`);
  const heading = page.locator('h1#screen-title');
  await expect(heading).toHaveText('Plan');
  await settled(page, 2);
  await heading.getByRole('button').hover();
  await shots(page, TASK, 'title-button');
  await heading.getByRole('button').click();
  await expect(page.getByRole('textbox', { name: 'Page title' })).toBeFocused();
  await shots(page, TASK, 'title-field');
});

test('the field of a new page', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'screenshots are taken once, in Chromium');
  await openShots(page, context, [p('a', null, 'p0000', 'Quarterly plan'), p('b', null, 'p0001', 'Meeting notes')], { firstNew: EMPTY_PAGE });
  await page.goto('/c/c1');
  await expect(page.getByRole('treeitem')).toHaveCount(2);
  await page.getByRole('button', { name: 'New page' }).click();
  await expect(page.getByRole('textbox', { name: 'Page title' })).toBeFocused();
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue('');
  await settled(page, 3);
  await shots(page, TASK, 'new-page');
});
