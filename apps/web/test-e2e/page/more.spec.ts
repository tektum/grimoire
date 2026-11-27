import { expect, type Page, test } from '@playwright/test';
import { mockApi } from '../collections/mock-api';
import { signInAs } from '../support/sign-in';

// The More menu of the page head: History for everyone who may read the page, and "Reset saved state…" for an administrator only; neither is a button on the page itself.
// Against a stand-in of the API (the editor has no collaboration server here). Needs a development build of the client (`bunx vite build --mode e2e`).
const p = (id: string, parentId: string | null, position: string, title: string) => ({ id, urlId: id.padEnd(8, '0'), parentId, position, title, icon: null });

async function open(page: Page, context: Parameters<typeof signInAs>[0], role: 'admin' | 'member') {
  await signInAs(context, 'e2e-alice', role, { check: false });
  await mockApi(page, { collections: [{ id: 'c1', name: 'Dev', myPermission: 'read-write' }], pages: [p('a', null, 'p0000', 'Quarterly plan')], role });
  await page.goto('/p/quarterly-plan-a0000000');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Quarterly plan');
  await expect(page.getByTestId('user-role')).toHaveText(role);
}

test('an administrator: History and Reset saved state… are in the menu, not on the page', async ({ page, context }) => {
  await open(page, context, 'admin');
  await expect(page.getByRole('button', { name: /Reset saved state/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'History' })).toHaveCount(0);
  const more = page.getByRole('button', { name: 'More page actions' });
  await expect(more).toHaveText('');
  await expect(more).toHaveAttribute('title', 'More page actions');
  await more.click();
  await expect(page.getByRole('menuitem')).toHaveText(['History', 'Reset saved state…']);
});

test('the reset item opens its dialog, which takes the focus, and closing it gives the focus back to More', async ({ page, context }) => {
  await open(page, context, 'admin');
  const more = page.getByRole('button', { name: 'More page actions' });
  await more.click();
  await page.getByRole('menuitem', { name: 'Reset saved state…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Reset the saved state of Quarterly plan?' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(':focus')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(more).toBeFocused();
  // and the page is usable again (a dialog that left the page inert would fail this click)
  await more.click();
  await expect(page.getByRole('menuitem', { name: 'History' })).toBeVisible();
});

test('a member: only History, which opens the history of the page', async ({ page, context }) => {
  await open(page, context, 'member');
  await page.getByRole('button', { name: 'More page actions' }).click();
  await expect(page.getByRole('menuitem')).toHaveText(['History']);
  await page.getByRole('menuitem', { name: 'History' }).click();
  await expect(page).toHaveURL(/\/p\/quarterly-plan-a0000000\/history$/);
});

test('with the keyboard alone: Tab to More, Enter opens the menu, the arrows move, Enter on History goes there, Escape closes the menu', async ({ page, context }) => {
  await open(page, context, 'admin');
  const more = page.getByRole('button', { name: 'More page actions' });
  for (let i = 0; i < 40 && !(await more.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab');
  await expect(more).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitem', { name: 'History' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Reset saved state…' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menuitem')).toHaveCount(0);
  await expect(more).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter'); // History
  await expect(page).toHaveURL(/\/history$/);
});
