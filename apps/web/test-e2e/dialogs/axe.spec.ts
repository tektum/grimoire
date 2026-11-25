import { expect, test, type Page } from '@playwright/test';
import { adminApi, type MockUser } from '../admin/mock-api';
import { mockApi } from '../collections/mock-api';
import { historyApi, SLUG } from '../history/mock-api';
import { expectNoAxeViolations } from '../support/axe';
import { signInAs } from '../support/sign-in';

// Every layer that the dialog library puts over the app (a menu, a dialog, a confirmation), opened with the whole shell around it (the header, the contents, the main area), checked by axe in both
// schemes. The library hides the rest of the app from a screen reader but leaves what is in it focusable, which axe reports (aria-hidden-focus); the app makes that rest inert (`ui/inert-layers.ts`).
// Against stand-ins of the API. Needs a development build of the client (`bunx vite build --mode e2e`).
const p = (id: string, parentId: string | null, position: string, title: string) => ({ id, urlId: id.padEnd(8, '0'), parentId, position, title, icon: null });
const PAGES = [p('a', null, 'p0000', 'Welcome'), p('b', null, 'p0001', 'Meeting notes')];
const u = (id: string, name: string, role: MockUser['role'] = 'member'): MockUser => ({ id, name, email: `${name.toLowerCase()}@dev.invalid`, role, suspended: false });

async function tree(page: Page, context: Parameters<typeof signInAs>[0], role: 'admin' | 'member' = 'member') {
  await signInAs(context, 'e2e-alice', role, { check: false });
  await mockApi(page, { collections: [{ id: 'c1', name: 'Dev', myPermission: 'read-write' }], pages: PAGES, role });
  await page.goto('/c/c1');
  await expect(page.getByRole('treeitem')).toHaveCount(2);
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} scheme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
    });

    test('the menu of a row of the contents tree', async ({ page, context }) => {
      await tree(page, context);
      await page.getByRole('button', { name: 'Actions for Welcome' }).click();
      await expect(page.getByRole('menuitem', { name: 'Rename' })).toBeVisible();
      await expectNoAxeViolations(page, { minImpact: 'serious' });
    });

    test('the Move dialog of the tree', async ({ page, context }) => {
      await tree(page, context);
      await page.getByRole('button', { name: 'Actions for Welcome' }).click();
      await page.getByRole('menuitem', { name: 'Move to…' }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await expectNoAxeViolations(page, { minImpact: 'serious' });
    });

    test('the delete confirmation of the tree', async ({ page, context }) => {
      await tree(page, context);
      await page.getByRole('button', { name: 'Actions for Welcome' }).click();
      await page.getByRole('menuitem', { name: 'Delete' }).click();
      await expect(page.getByRole('alertdialog')).toBeVisible();
      await expectNoAxeViolations(page, { minImpact: 'serious' });
    });

    test('the More menu of a page, and its reset dialog (administrator)', async ({ page, context }) => {
      await signInAs(context, 'e2e-alice', 'admin', { check: false });
      await mockApi(page, { collections: [{ id: 'c1', name: 'Dev', myPermission: 'read-write' }], pages: PAGES, role: 'admin' });
      await page.goto('/p/welcome-a0000000');
      await expect(page.locator('h1#screen-title')).toHaveText('Welcome');
      await page.getByRole('button', { name: 'More page actions' }).click();
      await expect(page.getByRole('menuitem', { name: 'History' })).toBeVisible();
      await expectNoAxeViolations(page, { minImpact: 'serious' });
      await page.getByRole('menuitem', { name: 'Reset saved state…' }).click();
      await expect(page.getByRole('dialog', { name: /Reset the saved state/ })).toBeVisible();
      await expectNoAxeViolations(page, { minImpact: 'serious' });
    });

    test('the restore confirmation of a version', async ({ page, context }) => {
      await signInAs(context, 'e2e-alice', 'member', { check: false });
      await historyApi(page, {
        role: 'member',
        current: '# Quarterly plan\n\nThe newer text\n',
        revisions: [
          {
            id: 'r1',
            createdAt: Date.parse('2026-11-20T10:00:00.000Z'),
            title: 'Quarterly plan',
            reason: 'manual',
            lastAuthor: { id: 'u1', name: 'Alice Example' },
            authors: [{ id: 'u1', name: 'Alice Example' }],
            markdown: '# Quarterly plan\n\nThe older text\n',
          },
        ],
      });
      await page.goto(`/p/${SLUG}/history/r1`);
      await page.getByRole('button', { name: 'Restore this version' }).click();
      await expect(page.getByRole('alertdialog', { name: 'Restore this version?' })).toBeVisible();
      await expectNoAxeViolations(page, { minImpact: 'serious' });
    });

    test('the suspend confirmation of the users screen', async ({ page, context }) => {
      await signInAs(context, 'e2e-alice', 'admin', { check: false });
      await adminApi(page, { role: 'admin', users: [u('u1', 'Alice', 'admin'), u('u3', 'Carol')] });
      await page.goto('/admin/users');
      await page.getByRole('button', { name: 'Suspend Carol' }).click();
      await expect(page.getByRole('alertdialog', { name: 'Suspend Carol?' })).toBeVisible();
      await expectNoAxeViolations(page, { minImpact: 'serious' });
    });
  });
}
