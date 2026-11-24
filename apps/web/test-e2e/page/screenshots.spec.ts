import { expect, test } from '@playwright/test';
import { mockApi } from '../collections/mock-api';
import { shots } from '../support/shots';
import { signInAs } from '../support/sign-in';

// The title of a page, edited in place, light and dark, 1280 by 800 (test-results/shots/M6-TITLE/): the title as the button it is, the field with the title in it, and the field of a new page.
// Against a stand-in of the API (the editor has no collaboration server here). Run by the same command as the other browser tests.
const TASK = 'M6-TITLE';
const p = (id: string, parentId: string | null, position: string, title: string) => ({ id, urlId: id.padEnd(8, '0'), parentId, position, title, icon: null });

test('the title of a page: the button, the field with the title, the field of a new page', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'screenshots are taken once, in Chromium');
  await signInAs(context, 'e2e-alice', 'member', { check: false });
  await mockApi(page, { collections: [{ id: 'c1', name: 'Dev', myPermission: 'read-write' }], pages: [p('a', null, 'p0000', 'Quarterly plan'), p('b', null, 'p0001', 'Meeting notes')] });
  await page.goto('/p/quarterly-plan-a0000000');
  const heading = page.getByRole('heading', { level: 1 });
  await expect(heading).toHaveText('Quarterly plan');
  await heading.getByRole('button').hover();
  await shots(page, TASK, 'title-button');

  await heading.getByRole('button').click();
  await expect(page.getByRole('textbox', { name: 'Page title' })).toBeFocused();
  await shots(page, TASK, 'title-field');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'New page' }).click();
  await expect(page.getByRole('textbox', { name: 'Page title' })).toBeFocused();
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue('');
  await shots(page, TASK, 'new-page');
});
