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
    await expect(page.getByLabel('User id'), 'the form is drawn (its chunk comes after the page)').toBeVisible(); // the first Tab press is after it, or it lands on an empty page
    await tabTo(page, page.getByLabel('User id'));
    await page.keyboard.type('e2e-keys');
    await tabTo(page, page.getByLabel('Secret'));
    await page.keyboard.type(devSecret());
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/c\//);
  });
});

test('the contents tree: a page is opened', async ({ browser, baseURL }) => {
  await walk(browser, baseURL, { userId: 'e2e-keys', role: 'member' }, async (page) => {
    await page.goto(`/c/${world.collectionId}`);
    await expect(page.getByRole('treeitem')).toHaveCount(2);
    await tabTo(page, page.getByRole('treeitem'));
    await page.keyboard.press('ArrowDown'); // Beta, after Alpha
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(world.beta.address);
  });
});

test('the contents tree: a page is moved through the menu of its row', async ({ browser, baseURL }) => {
  await api('e2e-admin', 'admin', 'POST', '/v1/pages', { collectionId: world.collectionId, title: 'Zeta mover', markdown: 'To be moved.\n' });
  await walk(browser, baseURL, { userId: 'e2e-keys', role: 'member' }, async (page) => {
    await page.goto(`/c/${world.collectionId}`);
    await expect(page.getByRole('treeitem').filter({ has: page.getByRole('link', { name: 'Zeta mover', exact: true }) })).toBeVisible();
    await tabTo(page, page.getByRole('treeitem'));
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
    await tabTo(page, page.getByRole('dialog').getByRole('button', { name: /^Alpha/ }));
    await page.keyboard.press('Enter');
    const row = page.getByRole('treeitem').filter({ has: page.getByRole('link', { name: 'Zeta mover', exact: true }) });
    await expect(row).toHaveAttribute('aria-level', '2');
  });
});

test('the page: text is typed, and a heading is made from the slash menu', async ({ browser, baseURL }) => {
  await walk(browser, baseURL, { userId: 'e2e-keys', role: 'member' }, async (page) => {
    await page.goto(world.alpha.path);
    await waitForSynced(page);
    await tabTo(page, page.locator('.ProseMirror'));
    await expect(page.locator('.ProseMirror'), 'a ring around the text when the focus came by Tab').toHaveCSS('outline-style', 'solid');
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
    await tabTo(page, page.getByRole('link', { name: /^History/ }));
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/history$/);
    await expect(page.getByRole('link', { name: /^Open this version/ }).first(), 'the list of versions is drawn (it is fetched after the page)').toBeVisible();
    await tabTo(page, page.getByRole('link', { name: /^Open this version/ }));
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/history\/[^/]+$/);
    await expect(page.getByRole('button', { name: 'Restore this version' })).toBeVisible();
    await tabTo(page, page.getByRole('button', { name: 'Restore this version' }));
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('alertdialog', { name: 'Restore this version?' });
    await expect(dialog).toBeVisible();
    await tabTo(page, page.getByRole('alertdialog').getByRole('button', { name: 'Restore', exact: true }));
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(world.alpha.address);
  });
});

test('the trash: a page is restored', async ({ browser, baseURL }) => {
  const title = `Back from the trash ${Date.now()}`;
  const made = await api<{ id: string }>('e2e-admin', 'admin', 'POST', '/v1/pages', { collectionId: world.collectionId, title, markdown: 'Restore me.\n' });
  await api('e2e-admin', 'admin', 'DELETE', `/v1/pages/${made.id}`);
  await walk(browser, baseURL, { userId: 'e2e-admin', role: 'admin' }, async (page) => {
    await page.goto('/trash');
    await expect(page.getByRole('button', { name: `Restore ${title}` })).toBeVisible();
    await tabTo(page, page.getByRole('button', { name: `Restore ${title}` }));
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: `Restore ${title}` })).toHaveCount(0);
  });
});

test('the admin screens: a role is changed, a group is made, the default access is changed', async ({ browser, baseURL }) => {
  await walk(browser, baseURL, { userId: 'e2e-admin', role: 'admin' }, async (page) => {
    await page.goto('/admin/users');
    await expect(page.getByRole('searchbox', { name: 'Search users' }), 'the screen is drawn (the page asks who is signed in first)').toBeVisible();
    await tabTo(page, page.getByRole('searchbox', { name: 'Search users' }));
    await page.keyboard.type(world.colleague.name);
    await page.keyboard.press('Enter');
    await expect(page.getByLabel(`Role of ${world.colleague.name}`), 'the list is drawn after the search').toBeVisible();
    await tabTo(page, page.getByLabel(`Role of ${world.colleague.name}`));
    await page.keyboard.press('ArrowDown'); // member to viewer
    await expect(page.getByLabel(`Role of ${world.colleague.name}`)).toHaveValue('viewer');

    await page.goto('/admin/groups');
    await expect(page.getByRole('textbox', { name: 'New group name' })).toBeVisible();
    const group = `Made with keys ${Date.now()}`; // a group name is unique on the stack, and the tour can be run again
    await tabTo(page, page.getByRole('textbox', { name: 'New group name' }));
    await page.keyboard.type(group);
    await page.keyboard.press('Enter');
    await expect(page.getByText(group, { exact: true })).toBeVisible();

    await page.goto(`/admin/collections/${world.collectionId}/access`);
    await expect(page.getByLabel('Everyone with an account can')).toBeVisible();
    await tabTo(page, page.getByLabel('Everyone with an account can'));
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
    await tabTo(page, page.getByRole('link', { name: 'Go to your collections' }));
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/c\//);
  });
});

test('the editor has no ring for a click, and has one for a Tab', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ ...(baseURL === undefined ? {} : { baseURL }), viewport: { width: 1280, height: 800 } });
  try {
    await signInAs(context, 'e2e-keys', 'member');
    const page = await context.newPage();
    await page.goto(world.alpha.path);
    await waitForSynced(page);
    const editor = page.locator('.ProseMirror');
    await expect(editor, 'the editor can be edited (a page that is still being opened is not)').toHaveAttribute('contenteditable', 'true');
    await editor.locator('p', { hasText: 'A second paragraph.' }).click();
    await expect(editor).toBeFocused();
    await expect(editor, 'the plain look after a click').toHaveCSS('outline-style', 'none');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(editor).toBeFocused();
    await expect(editor, 'the ring after a Tab').toHaveCSS('outline-style', 'solid');
    await expect(editor).toHaveCSS('outline-width', '2px');
  } finally {
    await context.close();
  }
});
