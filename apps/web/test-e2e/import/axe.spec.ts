import { expect, test } from '@playwright/test';
import { mockApi } from '../collections/mock-api';
import { expectNoAxeViolations } from '../support/axe';
import { signInAs } from '../support/sign-in';
import { scriptedImports, smallZip, type ScriptedItem, type ScriptedState } from './support';

// Axe on the import screen in each state, in both schemes. Against the stand-in of the API and a scripted import.
const STATES: readonly [string, ScriptedState][] = [
  ['running at 40 percent', { status: 'running', total: 10, done: 4 }],
  ['done', { status: 'done', total: 10, done: 9, skipped: 1 }],
  ['failed', { status: 'failed', total: 10, done: 3, error: 'internal' }],
  ['cancelled', { status: 'cancelled', total: 10, done: 3 }],
];

const REPORT: readonly ScriptedItem[] = [
  { id: 'i1', path: 'docs/welcome.md', status: 'ok' },
  { id: 'i2', path: 'docs/big.md', status: 'skipped', message: 'too_large' },
  { id: 'i3', path: 'docs/odd.md', status: 'failed', message: 'invalid-markdown', hasSource: true },
];

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} scheme`, () => {
    test.beforeEach(async ({ page, context }) => {
      await signInAs(context, 'e2e-alice', 'member', { check: false });
      await page.emulateMedia({ colorScheme: scheme });
      await mockApi(page, { collections: [{ id: 'c1', name: 'Dev', myPermission: 'read-write' }], pages: [] });
    });

    test('idle, with the duplicate warning, has no serious or critical violation', async ({ page }) => {
      await scriptedImports(page, []);
      await page.goto('/import');
      await expect(page.getByRole('note')).toBeVisible();
      await expectNoAxeViolations(page, { minImpact: 'serious' });
    });

    test('idle, with a part of an export in parts chosen and its note, has none', async ({ page }) => {
      await scriptedImports(page, []);
      await page.goto('/import');
      await page.getByLabel('Choose a .zip file').setInputFiles(smallZip('Export-3f2a91c4-Part-1.zip'));
      await expect(page.getByRole('status')).toContainText('This looks like one part of an export split into parts.');
      await expectNoAxeViolations(page, { minImpact: 'serious' });
      await page.getByRole('radio', { name: 'Markdown files' }).check();
      await expectNoAxeViolations(page, { minImpact: 'serious' });
    });

    test('done, with its report (a skipped and a failed file with a source to download), has none', async ({ page }) => {
      await scriptedImports(page, [{ status: 'done', total: 3, done: 1, skipped: 1, failed: 1 }], { items: REPORT });
      await page.goto('/import?import=imp1');
      await expect(page.getByRole('list', { name: 'Files of the import' }).getByRole('listitem')).toHaveCount(3);
      await expectNoAxeViolations(page, { minImpact: 'serious' });
    });

    test('running, with its Cancel button, has none', async ({ page }) => {
      await scriptedImports(page, [{ status: 'running', total: 10, done: 4 }]);
      await page.goto('/import?import=imp1');
      await expect(page.getByRole('button', { name: 'Cancel import' })).toBeVisible();
      await expectNoAxeViolations(page, { minImpact: 'serious' });
    });

    for (const [name, state] of STATES) {
      test(`${name} has none`, async ({ page }) => {
        await scriptedImports(page, [state]);
        await page.goto('/import?import=imp1');
        await expect(page.getByRole('progressbar')).toBeVisible();
        await expectNoAxeViolations(page, { minImpact: 'serious' });
      });
    }
  });
}
