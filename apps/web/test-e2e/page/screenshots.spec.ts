import { expect, test, type Page } from '@playwright/test';
import { mockApi } from '../collections/mock-api';
import { SCRIPTED_PAGE_ID, SCRIPTED_URL_ID } from '../editor/scripted';
import { shots } from '../support/shots';
import { signInAs } from '../support/sign-in';

// The title of a page, edited in place, light and dark, 1280 by 800 (test-results/shots/M6-TITLE/): the title as the button it is, the field with the title in it, and the field of a new page.
// Against a stand-in of the API (the editor has no collaboration server here). Run by the same command as the other browser tests.
const TASK = 'M6-TITLE';
// The editor joins a collaboration server only when `E2E_SHOT_COLLAB` (its address) is set: the pages here are the stand-in API's, which a real server does not know, so the shots are
// taken with a collaboration server that accepts any page. Without it the status line says "Connecting…", which these specifications do not look at.
const COLLAB = process.env['E2E_SHOT_COLLAB'];

/** The page is settled: the tree is drawn, the person's name is shown and, with a collaboration server, the editor has joined (no "Connecting…"). `E2E_SHOT_FONT` (a font stack) stands in for the interface font where the machine has none that looks like the product's. */
async function settled(page: Page, tree: number): Promise<void> {
  await expect(page.getByRole('treeitem')).toHaveCount(tree);
  await expect(page.getByText('Alice Archer')).toBeVisible();
  if (COLLAB !== undefined) await expect(page.getByTestId('editor-root')).toHaveAttribute('data-collab-state', 'synced');
  const font = process.env['E2E_SHOT_FONT'];
  if (font !== undefined) await page.addStyleTag({ content: `:root { --font-ui: ${font}; }` });
}
const p = (id: string, parentId: string | null, position: string, title: string, urlId = id.padEnd(8, '0')) => ({ id, urlId, parentId, position, title, icon: null });
// The one page that the collaboration server of the shots knows is SCRIPTED_PAGE_ID (urlId abc123).
const open = async (page: Page, context: Parameters<typeof signInAs>[0], pages: ReturnType<typeof p>[], extra: { firstNewPageId?: string; firstNewPageUrlId?: string } = {}) => {
  await signInAs(context, 'e2e-alice', 'member', { check: COLLAB !== undefined }); // the collaboration server of the shots checks the token: it has to be a real one
  await mockApi(page, { collections: [{ id: 'c1', name: 'Dev', myPermission: 'read-write' }], pages, userName: 'Alice Archer', ...extra, ...(COLLAB === undefined ? {} : { collabUrl: COLLAB }) });
};

test('the title of a page: the button, and the field with the title', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'screenshots are taken once, in Chromium');
  await open(page, context, [p(SCRIPTED_PAGE_ID, null, 'p0000', 'Plan', 'abc123'), p('b', null, 'p0001', 'Meeting notes')]);
  await page.goto('/p/plan-abc123');
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
  await open(page, context, [p('a', null, 'p0000', 'Quarterly plan'), p('b', null, 'p0001', 'Meeting notes')], { firstNewPageId: SCRIPTED_PAGE_ID, firstNewPageUrlId: SCRIPTED_URL_ID });
  await page.goto('/c/c1');
  await expect(page.getByRole('treeitem')).toHaveCount(2);
  await page.getByRole('button', { name: 'New page' }).click();
  await expect(page.getByRole('textbox', { name: 'Page title' })).toBeFocused();
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveValue('');
  await settled(page, 3);
  await shots(page, TASK, 'new-page');
});
