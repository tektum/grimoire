import { expect, type Page, test } from '@playwright/test';
import { signInAs } from '../support/sign-in';
import { mockApi } from './mock-api';

// Keyboard only: a page is moved with Tab, Enter on the row menu and the dialog, and no pointer event is made (`page.mouse` and click() are not used).
const p = (id: string, parentId: string | null, position: string, title: string) => ({ id, urlId: id.padEnd(8, '0'), parentId, position, title, icon: null });
const tabUntil = async (page: Page, test_: (el: Element | null) => boolean) => {
  for (let i = 0; i < 20; i += 1) {
    if (await page.evaluate(`(${test_.toString()})(document.activeElement)`)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('the focus never reached the element');
};

test('move a page under another with the keyboard alone', async ({ page, context }) => {
  await signInAs(context, 'e2e-alice', 'member', { check: false });
  const api = await mockApi(page, { collections: [{ id: 'c1', name: 'Dev', myPermission: 'read-write' }], pages: [p('a', null, 'p0000', 'Alpha'), p('b', null, 'p0001', 'Beta')] });
  await page.goto('/c/c1');
  await expect(page.getByRole('treeitem')).toHaveCount(2);
  await tabUntil(page, (el) => el?.getAttribute('role') === 'treeitem'); // the tree is one stop: its first row
  await page.keyboard.press('ArrowDown'); // Beta
  await page.keyboard.press('Tab'); // the menu button of the focused row
  expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Actions for Beta');
  await page.keyboard.press('Enter'); // opens the row menu
  await expect(page.getByRole('menuitem', { name: 'Rename' })).toBeFocused(); // the menu puts the focus on its first item
  await page.keyboard.press('ArrowDown'); // Rename, New page inside, Move to…: the menu moves its focus a moment after each key
  await expect(page.getByRole('menuitem', { name: 'New page inside' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Move to…' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Move Beta to…' })).toBeVisible();
  await tabUntil(page, (el) => el?.textContent === 'Alpha');
  await page.keyboard.press('Enter');
  await expect.poll(() => api.writes().length).toBe(1);
  const beta = page.getByRole('treeitem').filter({ has: page.getByRole('link', { name: 'Beta', exact: true }) });
  await expect(beta).toHaveAttribute('aria-level', '2');
});
