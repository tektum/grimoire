import { expect, test } from '@playwright/test';
import { mockApi } from '../collections/mock-api';
import { makePage } from '../editor/pages';
import { shots } from '../support/shots';
import { signInAs } from '../support/sign-in';
import { waitForSynced } from '../support/sync';
import { tabTo } from './support';

// What the keyboard walk shows: where the focus is (test-results/shots/m6-t10/, light and dark, 1280 by 800). The tree and the dialog are the real screens with the API stood in for;
// the editor is on the stack. Taken once, in Chromium.
const TASK = 'm6-t10';
const p = (id: string, parentId: string | null, position: string, title: string) => ({ id, urlId: id.padEnd(8, '0'), parentId, position, title, icon: null });
const COLLECTIONS = [{ id: 'c1', name: 'Handbook', myPermission: 'read-write' as const }];
const PAGES = [p('welcome', null, 'p0', 'Welcome'), p('guide', 'welcome', 'p0', 'Getting started'), p('plan', null, 'p1', 'Plan for May'), p('notes', null, 'p2', 'Meeting notes')];

for (const reduced of [false, true]) {
  test(`the contents tree with the focus on a row${reduced ? ', with reduced motion' : ''}`, async ({ page, context, browserName }) => {
    test.skip(browserName !== 'chromium', 'screenshots are taken once, in Chromium');
    await signInAs(context, 'e2e-alice', 'member', { check: false });
    await mockApi(page, { collections: COLLECTIONS, pages: PAGES });
    if (reduced) await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/c/c1');
    await expect(page.getByRole('treeitem')).toHaveCount(4);
    await tabTo(page, page.getByRole('treeitem'));
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await shots(page, TASK, reduced ? 'tree-focus-reduced-motion' : 'tree-focus');
  });
}

test('the contents tree in a window 320 pixels wide (a page at 400% zoom)', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'screenshots are taken once, in Chromium');
  await signInAs(context, 'e2e-alice', 'member', { check: false });
  await mockApi(page, { collections: COLLECTIONS, pages: PAGES });
  await page.goto('/c/c1');
  await expect(page.getByRole('treeitem')).toHaveCount(4);
  await shots(page, TASK, 'narrow-320', { width: 320 });
});

test('the Move to dialog with the focus on a choice', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'screenshots are taken once, in Chromium');
  await signInAs(context, 'e2e-alice', 'member', { check: false });
  await mockApi(page, { collections: COLLECTIONS, pages: PAGES });
  await page.goto('/c/c1');
  await expect(page.getByRole('treeitem')).toHaveCount(4);
  await tabTo(page, page.getByRole('treeitem'));
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitem', { name: 'Rename' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'New page inside' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Move to…' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Move Plan for May to…' })).toBeVisible();
  await tabTo(page, page.getByRole('dialog').getByRole('button', { name: /^Welcome/ }));
  await shots(page, TASK, 'dialog-focus');
});

test('the editor with the focus in the text', async ({ browser, baseURL, browserName }) => {
  test.skip(browserName !== 'chromium', 'screenshots are taken once, in Chromium');
  const made = await makePage('A page for the keyboard.\n\nThe cursor is in this line.\n', { title: 'Keyboard walk' });
  const context = await browser.newContext({ ...(baseURL === undefined ? {} : { baseURL }), viewport: { width: 1280, height: 800 } });
  try {
    await signInAs(context, 'e2e-alice', 'member');
    const page = await context.newPage();
    await page.goto(made.path);
    await waitForSynced(page);
    await tabTo(page, page.locator('.ProseMirror'));
    await page.keyboard.press('Control+End');
    await shots(page, TASK, 'editor-focus');
  } finally {
    await context.close();
  }
});
