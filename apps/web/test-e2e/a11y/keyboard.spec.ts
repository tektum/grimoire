import { expect, test, type Browser, type Page } from '@playwright/test';
import { devSecret } from '../support/env';
import { signInAs } from '../support/sign-in';
import { waitForSynced } from '../support/sync';
import { api, prepareWorld, type World } from './world';
import { COUNT_POINTER_EVENTS, focusedLabel, pointerEvents, tabTo } from './support';

// The primary action of every screen, reached and used with the keyboard alone (needs the whole stack). Every page counts its pointer events (support.ts) and a walk ends
// by expecting none: a mouse press, a release, or a click that a pointer made. The pages are opened with a URL, which is not an action of the person.
test.describe.configure({ mode: 'serial' });

let world: World;

test.beforeAll(async ({ browser, baseURL }) => {
  test.slow(); // the stack side of the tour: collections, pages and a saved version
  world = await prepareWorld(browser, baseURL);
});

async function walk(browser: Browser, baseURL: string | undefined, who: { userId: string; role: 'member' | 'admin' } | null, work: (page: Page) => Promise<void>): Promise<void> {
  const context = await browser.newContext({ ...(baseURL === undefined ? {} : { baseURL }), viewport: { width: 1280, height: 800 } });
  try {
    await context.addInitScript(COUNT_POINTER_EVENTS);
    if (who !== null) await signInAs(context, who.userId, who.role);
    const page = await context.newPage();
    await work(page);
    expect(await pointerEvents(page), 'pointer events during a walk with the keyboard alone').toBe(0);
  } finally {
    await context.close();
  }
}

/** For `tabTo(page, isLabelled, { arg: label })`: it runs in the page, so the label comes as the argument. */
const isLabelled = (element: Element | null, label: string): boolean => element?.getAttribute('aria-label') === label;

test('the walk counts a mouse click (so that "no pointer events" says something)', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ ...(baseURL === undefined ? {} : { baseURL }) });
  try {
    await context.addInitScript(COUNT_POINTER_EVENTS);
    await signInAs(context, 'e2e-keys', 'member');
    const page = await context.newPage();
    await page.goto('/help');
    expect(await pointerEvents(page)).toBe(0);
    await page.getByRole('heading', { level: 1 }).click();
    expect(await pointerEvents(page)).toBeGreaterThan(0);
  } finally {
    await context.close();
  }
});

test('sign in: the form is filled and sent with the keyboard', async ({ browser, baseURL }) => {
  await walk(browser, baseURL, null, async (page) => {
    await page.goto('/login');
    await tabTo(page, (el) => (el as HTMLInputElement | null)?.labels?.[0]?.textContent?.startsWith('User id') === true);
    await page.keyboard.type('e2e-keys');
    await tabTo(page, (el) => (el as HTMLInputElement | null)?.labels?.[0]?.textContent?.startsWith('Secret') === true);
    await page.keyboard.type(devSecret());
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/c\//);
  });
});

test('the contents tree: a page is opened', async ({ browser, baseURL }) => {
  await walk(browser, baseURL, { userId: 'e2e-keys', role: 'member' }, async (page) => {
    await page.goto(`/c/${world.collectionId}`);
    await expect(page.getByRole('treeitem')).toHaveCount(2);
    await tabTo(page, (el) => el?.getAttribute('role') === 'treeitem');
    await page.keyboard.press('ArrowDown'); // Beta, after Alpha
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`${world.beta.path}$`));
  });
});

test('the contents tree: a page is moved through the menu of its row', async ({ browser, baseURL }) => {
  await api('e2e-admin', 'admin', 'POST', '/v1/pages', { collectionId: world.collectionId, title: 'Zeta mover', markdown: 'To be moved.\n' });
  await walk(browser, baseURL, { userId: 'e2e-keys', role: 'member' }, async (page) => {
    await page.goto(`/c/${world.collectionId}`);
    await expect(page.getByRole('treeitem').filter({ has: page.getByRole('link', { name: 'Zeta mover', exact: true }) })).toBeVisible();
    await tabTo(page, (el) => el?.getAttribute('role') === 'treeitem');
    await page.keyboard.press('ArrowDown'); // Beta
    await page.keyboard.press('ArrowDown'); // Zeta mover, the last of the three
    await page.keyboard.press('Tab'); // the menu button of that row
    expect(await focusedLabel(page)).toBe('Actions for Zeta mover');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menuitem', { name: 'Rename' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: 'New page inside' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('menuitem', { name: 'Move to…' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Move Zeta mover to…' })).toBeVisible();
    await tabTo(page, (el) => el?.textContent?.startsWith('Alpha') === true);
    await page.keyboard.press('Enter');
    const row = page.getByRole('treeitem').filter({ has: page.getByRole('link', { name: 'Zeta mover', exact: true }) });
    await expect(row).toHaveAttribute('aria-level', '2');
  });
});

test('the page: text is typed, and a heading is made from the slash menu', async ({ browser, baseURL }) => {
  await walk(browser, baseURL, { userId: 'e2e-keys', role: 'member' }, async (page) => {
    await page.goto(world.alpha.path);
    await waitForSynced(page);
    await tabTo(page, (el) => el?.classList.contains('ProseMirror') === true);
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('/');
    await page.getByRole('option').first().waitFor();
    await page.keyboard.press('ArrowDown'); // Heading 1, after Text
    await page.keyboard.press('Enter');
    await page.keyboard.type('Made with keys');
    await expect(page.locator('.ProseMirror h1', { hasText: 'Made with keys' })).toBeVisible();
  });
});

test('history: a version is opened and restored', async ({ browser, baseURL }) => {
  await walk(browser, baseURL, { userId: 'e2e-keys', role: 'member' }, async (page) => {
    await page.goto(world.alpha.path);
    await waitForSynced(page);
    await tabTo(page, (el) => el?.tagName === 'A' && el.textContent?.trim().startsWith('History') === true);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/history$/);
    await tabTo(page, (el) => el?.tagName === 'A' && (el.getAttribute('aria-label') ?? '').startsWith('Open this version'));
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/history\/[^/]+$/);
    await tabTo(page, (el) => el?.textContent?.trim() === 'Restore this version');
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('alertdialog', { name: 'Restore this version?' });
    await expect(dialog).toBeVisible();
    await tabTo(page, (el) => el?.textContent?.trim() === 'Restore');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`${world.alpha.path}$`));
  });
});

test('the trash: a page is restored', async ({ browser, baseURL }) => {
  const title = `Back from the trash ${Date.now()}`;
  const made = await api<{ id: string }>('e2e-admin', 'admin', 'POST', '/v1/pages', { collectionId: world.collectionId, title, markdown: 'Restore me.\n' });
  await api('e2e-admin', 'admin', 'DELETE', `/v1/pages/${made.id}`);
  await walk(browser, baseURL, { userId: 'e2e-admin', role: 'admin' }, async (page) => {
    await page.goto('/trash');
    await expect(page.getByRole('button', { name: `Restore ${title}` })).toBeVisible();
    await tabTo(page, isLabelled, { arg: `Restore ${title}` });
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: `Restore ${title}` })).toHaveCount(0);
  });
});

test('the admin screens: a role is changed, a group is made, the default access is changed', async ({ browser, baseURL }) => {
  await walk(browser, baseURL, { userId: 'e2e-admin', role: 'admin' }, async (page) => {
    await page.goto('/admin/users');
    await tabTo(page, isLabelled, { arg: 'Search users' });
    await page.keyboard.type(world.colleague.name);
    await page.keyboard.press('Enter');
    await tabTo(page, isLabelled, { arg: `Role of ${world.colleague.name}` });
    await page.keyboard.press('ArrowDown'); // member to viewer
    await expect(page.getByLabel(`Role of ${world.colleague.name}`)).toHaveValue('viewer');

    await page.goto('/admin/groups');
    const group = `Made with keys ${Date.now()}`; // a group name is unique on the stack, and the tour can be run again
    await tabTo(page, isLabelled, { arg: 'New group name' });
    await page.keyboard.type(group);
    await page.keyboard.press('Enter');
    await expect(page.getByText(group, { exact: true })).toBeVisible();

    await page.goto(`/admin/collections/${world.collectionId}/access`);
    await tabTo(page, isLabelled, { arg: 'Everyone with an account can' });
    const before = await page.getByLabel('Everyone with an account can').inputValue();
    await page.keyboard.press('ArrowDown');
    if ((await page.getByLabel('Everyone with an account can').inputValue()) === before) await page.keyboard.press('ArrowUp'); // it was the last choice
    await expect(page.getByLabel('Everyone with an account can')).not.toHaveValue(before);
  });
});

test('the screens with nothing to do but read, and the way out of the not-found screen', async ({ browser, baseURL }) => {
  await walk(browser, baseURL, { userId: 'e2e-keys', role: 'member' }, async (page) => {
    await page.goto('/help');
    await expect(page.getByRole('heading', { level: 1, name: 'Editing together' })).toBeVisible();
    await page.goto('/nowhere/at/all');
    await tabTo(page, (el) => el?.tagName === 'A' && el.textContent?.trim() === 'Go to your collections');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/c\//);
  });
});
