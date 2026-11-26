import { expect, test } from '@playwright/test';
import { mockApi } from '../collections/mock-api';
import { expectNoAxeViolations } from '../support/axe';
import { horizontalOverflow } from '../a11y/support';
import { signInAs } from '../support/sign-in';
import { CONSTRUCT_REPORT, scriptedImports, smallZip, type ScriptedItem, type ScriptedState } from './support';

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

    test('done, with the construct report (every kind, the pages behind a disclosure opened, the pages that hold HTML), has none', async ({ page }) => {
      await scriptedImports(page, [{ status: 'done', total: 5, done: 5, report: CONSTRUCT_REPORT }], { items: REPORT });
      await page.goto('/import?import=imp1');
      await expect(page.getByRole('rowheader')).toHaveCount(9);
      await expectNoAxeViolations(page, { minImpact: 'serious' });
      for (const summary of await page.locator('.import-constructs summary').all()) await summary.click();
      await expectNoAxeViolations(page, { minImpact: 'serious' });
    });

    test('the construct report does not scroll sideways at 320 CSS pixels (400% zoom), its lists opened', async ({ page }) => {
      await scriptedImports(page, [{ status: 'done', total: 5, done: 5, report: CONSTRUCT_REPORT }], { items: REPORT });
      await page.setViewportSize({ width: 320, height: 640 });
      await page.goto('/import?import=imp1');
      await expect(page.getByRole('rowheader')).toHaveCount(9);
      for (const summary of await page.locator('.import-constructs summary').all()) await summary.click();
      expect(await horizontalOverflow(page)).toBe(0);
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
