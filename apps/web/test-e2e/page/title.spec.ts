import { expect, type Page, test } from '@playwright/test';
import { API, mockApi } from '../collections/mock-api';
import { signInAs } from '../support/sign-in';

// The title of a page, edited in place (R14.6: a plain field, saved through the API like the tree's rename). Against a stand-in of the API that keeps the pages in memory; the editor
// has no collaboration server here, which the title does not need. Needs a development build of the client (`bunx vite build --mode e2e`).
const p = (id: string, parentId: string | null, position: string, title: string) => ({ id, urlId: id.padEnd(8, '0'), parentId, position, title, icon: null });
const names = (page: Page) => page.locator('[role="treeitem"] .tree-link').allInnerTexts();
const heading = (page: Page) => page.getByRole('heading', { level: 1 });

async function open(page: Page, context: Parameters<typeof signInAs>[0], pages = [p('a', null, 'p0000', 'Welcome'), p('b', null, 'p0001', 'Notes')]) {
  await signInAs(context, 'e2e-alice', 'member', { check: false });
  const api = await mockApi(page, { collections: [{ id: 'c1', name: 'Dev', myPermission: 'read-write' }], pages });
  await page.goto('/p/welcome-a0000000');
  await expect(heading(page)).toHaveText('Welcome');
  return api;
}

test('click the title, type, Enter: the page, the tree and the address have the new title, one rename went to the API, and the editor is not remounted', async ({ page, context }) => {
  const api = await open(page, context);
  await page.evaluate(() => document.querySelector('[data-testid="editor-root"]')?.setAttribute('data-mounted-before', 'yes')); // a remount would give a new element without it
  await heading(page).getByRole('button').click();
  const field = page.getByRole('textbox', { name: 'Page title' });
  await expect(field).toBeFocused();
  await field.fill('Handbook 2');
  await page.keyboard.press('Enter');
  await expect(heading(page)).toHaveText('Handbook 2');
  await expect(heading(page).getByRole('button')).toBeFocused();
  await expect.poll(() => names(page)).toEqual(['Handbook 2', 'Notes']);
  await expect(page).toHaveURL(/\/p\/handbook-2-a0000000$/); // the address follows the title, and the page was not rebuilt for it (the editor element below is the same one)
  expect(await page.evaluate(() => document.querySelector('[data-testid="editor-root"]')?.getAttribute('data-mounted-before'))).toBe('yes');
  expect(api.writes()).toEqual(['PATCH /v1/pages/a']);
});

test('Escape puts the field away and keeps the title, and nothing is sent', async ({ page, context }) => {
  const api = await open(page, context);
  await heading(page).getByRole('button').click();
  await page.getByRole('textbox', { name: 'Page title' }).fill('Never saved');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveCount(0);
  await expect(heading(page)).toHaveText('Welcome');
  await expect(heading(page).getByRole('button')).toBeFocused();
  expect(api.writes()).toEqual([]);
});

test('with the keyboard alone: Tab to the title, Enter opens the field, Enter saves', async ({ page, context }) => {
  const api = await open(page, context);
  const button = heading(page).getByRole('button');
  for (let i = 0; i < 40 && !(await button.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab');
  await expect(button).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.type('Typed');
  await page.keyboard.press('Enter');
  await expect(heading(page)).toHaveText('Typed');
  expect(api.writes()).toEqual(['PATCH /v1/pages/a']);
});

test('the field takes 255 characters and no more', async ({ page, context }) => {
  await open(page, context);
  await heading(page).getByRole('button').click();
  const field = page.getByRole('textbox', { name: 'Page title' });
  await field.fill('x'.repeat(300));
  expect((await field.inputValue()).length).toBe(255);
});

test('a new page opens with its title field focused and empty, and what is typed names it', async ({ page, context }) => {
  const api = await open(page, context);
  await page.getByRole('button', { name: 'New page' }).click();
  await expect(page).toHaveURL(/\/p\/page-new10000$/);
  const field = page.getByRole('textbox', { name: 'Page title' });
  await expect(field).toBeFocused();
  await expect(field).toHaveValue('');
  await expect.poll(() => page.evaluate(() => (history.state as { usr?: unknown } | null)?.usr ?? null)).toBeNull(); // the sign of a new page is used up once the field is open
  await page.keyboard.type('Roadmap');
  await page.keyboard.press('Enter');
  await expect(heading(page)).toHaveText('Roadmap');
  await expect.poll(() => names(page)).toEqual(['Welcome', 'Notes', 'Roadmap']);
  await expect(page).toHaveURL(/\/p\/roadmap-new10000$/);
  expect(api.writes()).toEqual(['POST /v1/pages', 'PATCH /v1/pages/new1']);
});

test('a new page left without a title stays "Untitled", and its heading is still the button to name it', async ({ page, context }) => {
  const api = await open(page, context);
  await page.getByRole('button', { name: 'New page' }).click();
  await expect(page.getByRole('textbox', { name: 'Page title' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(heading(page)).toHaveText('Untitled');
  await expect.poll(() => names(page)).toEqual(['Welcome', 'Notes', 'Untitled']);
  expect(api.writes()).toEqual(['POST /v1/pages']);
});

test('an old address of a renamed page still opens it, and so does the new one after a reload', async ({ page, context }) => {
  await open(page, context);
  await heading(page).getByRole('button').click();
  await page.getByRole('textbox', { name: 'Page title' }).fill('Renamed');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/p\/renamed-a0000000$/);
  await page.goto('/p/welcome-a0000000'); // a link made before the rename
  await expect(heading(page)).toHaveText('Renamed');
  await page.reload();
  await expect(heading(page)).toHaveText('Renamed');
});

test('a title saved by leaving the field for another page in the tree does not take the person back: the address stays on the page they opened', async ({ page, context }) => {
  const api = await open(page, context);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`${API}/v1/pages/a`, async (route) => {
    if (route.request().method() === 'PATCH') await gate; // the rename is still on its way when the person clicks
    await route.fallback();
  });
  await heading(page).getByRole('button').click();
  await page.getByRole('textbox', { name: 'Page title' }).fill('Renamed');
  await page.getByRole('link', { name: 'Notes', exact: true }).click(); // leaving the field saves it; the click opens the other page
  await expect(page).toHaveURL(/\/p\/notes-b0000000$/);
  await expect(heading(page)).toHaveText('Notes');
  release();
  await expect.poll(() => api.writes()).toEqual(['PATCH /v1/pages/a']);
  await expect.poll(() => names(page)).toEqual(['Renamed', 'Notes']);
  await expect(page).toHaveURL(/\/p\/notes-b0000000$/); // the renamed page's address did not replace this one
  await expect(heading(page)).toHaveText('Notes');
});
