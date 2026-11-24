import { expect, test, type Browser, type Page } from '@playwright/test';
import { signInAs } from '../support/sign-in';
import { waitForSynced } from '../support/sync';
import { STOPS, stopReady } from './routes';
import { axeBothSchemes, blockingText, summaryLine, type StopReport } from './support';
import { prepareWorld, type World } from './world';

// One run through every route of the route table, and through the editor's menus, a dialog and the admin screens, with axe on each in the light and the dark scheme
// (needs the whole stack, `make test-web-e2e`). The run reports every finding of every stop at the end, not only the first, and prints one summary line per stop.
test.describe.configure({ mode: 'serial' });

let world: World;
const reports: StopReport[] = [];

async function visit(browser: Browser, baseURL: string | undefined, who: 'nobody' | 'member' | 'admin', work: (page: Page) => Promise<void>): Promise<void> {
  const context = await browser.newContext({ ...(baseURL === undefined ? {} : { baseURL }), viewport: { width: 1280, height: 800 } });
  try {
    if (who !== 'nobody') await signInAs(context, who === 'admin' ? 'e2e-admin' : 'e2e-tourist', who);
    await work(await context.newPage());
  } finally {
    await context.close();
  }
}

test.beforeAll(async ({ browser, baseURL }) => {
  test.slow(); // the stack side of the tour: collections, pages and a saved version
  world = await prepareWorld(browser, baseURL);
});

test.afterAll(() => {
  for (const report of reports) console.log(`axe ${summaryLine(report)}`);
});

test('every route has no serious or critical violation, in the light and the dark scheme', async ({ browser, baseURL }) => {
  test.slow();
  const found: StopReport[] = [];
  for (const stop of STOPS) {
    await visit(browser, baseURL, stop.who === 'nobody' ? 'nobody' : stop.who === 'admin' ? 'admin' : 'member', async (page) => {
      await page.goto(stop.path(world));
      await stopReady(stop, page, world);
      found.push(...(await axeBothSchemes(page, stop.route)));
    });
  }
  reports.push(...found);
  expect(blockingText(found), 'serious or critical violations').toBe('');
});

test('the editor with its slash menu, bubble and block menu open, and the dialogs, have no serious or critical violation', async ({ browser, baseURL }) => {
  test.slow();
  const found: StopReport[] = [];
  await visit(browser, baseURL, 'member', async (page) => {
    await page.goto(world.alpha.path);
    await waitForSynced(page);
    const editor = page.locator('.ProseMirror');

    await editor.locator('p', { hasText: 'A second paragraph.' }).click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('/');
    await page.getByRole('option').first().waitFor();
    found.push(...(await axeBothSchemes(page, 'editor: slash menu')));
    await page.keyboard.press('Escape');
    await page.keyboard.press('Backspace');

    await editor.locator('p', { hasText: 'first paragraph' }).click();
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+Control+ArrowRight'); // the first word: a key selects it, where a double click on the middle of the line could land on a space
    await page.getByRole('toolbar', { name: 'Text formatting' }).waitFor();
    found.push(...(await axeBothSchemes(page, 'editor: bubble')));
    await page.keyboard.press('Control+k');
    await page.getByRole('textbox', { name: 'Link address' }).waitFor();
    found.push(...(await axeBothSchemes(page, 'editor: link editor')));
    await page.keyboard.press('Escape');

    await editor.locator('p').first().hover();
    await page.getByRole('button', { name: 'Block menu' }).press('Enter');
    await page.getByRole('listbox', { name: 'Turn this block into' }).waitFor();
    found.push(...(await axeBothSchemes(page, 'editor: block menu')));
    await page.keyboard.press('Escape');

    await expect(page.getByRole('status').first()).toBeVisible();
    found.push(...(await axeBothSchemes(page, 'editor: status line')));
  });
  await visit(browser, baseURL, 'member', async (page) => {
    await page.goto(`/c/${world.collectionId}`);
    await page.getByRole('button', { name: `Actions for ${world.beta.title}` }).click();
    await page.getByRole('menuitem', { name: 'Move to…' }).click();
    await page.getByRole('dialog', { name: `Move ${world.beta.title} to…` }).waitFor();
    found.push(...(await axeBothSchemes(page, 'dialog: move a page')));
  });
  await visit(browser, baseURL, 'member', async (page) => {
    await page.goto(`${world.alpha.path}/history/${world.revisionId}`);
    await page.getByRole('button', { name: 'Restore this version' }).click();
    await page.getByRole('alertdialog', { name: 'Restore this version?' }).waitFor();
    found.push(...(await axeBothSchemes(page, 'dialog: restore a version')));
  });
  await visit(browser, baseURL, 'admin', async (page) => {
    await page.goto('/admin/users');
    await page.getByRole('searchbox', { name: 'Search users' }).fill(world.colleague.name);
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: new RegExp(`^Suspend ${world.colleague.name}$`) }).click();
    await page.getByRole('alertdialog', { name: new RegExp(`^Suspend ${world.colleague.name}\\?$`) }).waitFor();
    found.push(...(await axeBothSchemes(page, 'dialog: suspend a person')));
    await page.goto(`/admin/groups?group=${world.groupId}`);
    await page.getByRole('heading', { level: 2, name: /^Members of/ }).waitFor();
    found.push(...(await axeBothSchemes(page, 'admin: a group open')));
  });
  reports.push(...found);
  expect(blockingText(found), 'serious or critical violations').toBe('');
});
