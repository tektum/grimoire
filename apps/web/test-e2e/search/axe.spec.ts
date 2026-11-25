import { expect, test } from '@playwright/test';
import { mockApi } from '../collections/mock-api';
import { expectNoAxeViolations } from '../support/axe';
import { signInAs } from '../support/sign-in';
import { hit, scriptedSearch } from './support';

// Axe on the search screen (with results, empty and with nothing asked) and with the palette open, in both schemes. Against the stand-in of the API and the scripted search.
for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} scheme`, () => {
    test.beforeEach(async ({ page, context }) => {
      await signInAs(context, 'e2e-alice', 'member', { check: false });
      await page.emulateMedia({ colorScheme: scheme });
      await mockApi(page, { collections: [{ id: 'c1', name: 'Dev', myPermission: 'read-write' }], pages: [{ id: 'a', urlId: 'a0000000', parentId: null, position: 'p0', title: 'Welcome', icon: null }] });
      await scriptedSearch(page, (q) => ({
        items: q === 'empty' ? [] : [hit('r1', 'r1000000', 'Product plan', 'the roadmap for the quarter', [[4, 11]], { matchedPassage: { text: 'a passage by meaning' }, partial: true })],
      }));
    });

    test('/search with results has no serious or critical violation', async ({ page }) => {
      await page.goto('/search?q=roadmap');
      await expect(page.getByRole('link', { name: 'Product plan' })).toBeVisible();
      await expectNoAxeViolations(page, { minImpact: 'serious' });
    });

    test('/search with a result that has a passage and a partial notice has none (the passage specification of the acceptance, where Firefox cannot run axe)', async ({ page }) => {
      await page.goto('/search?q=roadmap');
      await expect(page.locator('.search-passage')).toBeVisible();
      await expect(page.locator('.search-partial')).toBeVisible();
      await expectNoAxeViolations(page, { minImpact: 'serious' });
    });

    test('/search with no results, and with nothing asked, has none', async ({ page }) => {
      await page.goto('/search?q=empty');
      await expect(page.getByText('No results')).toBeVisible();
      await expectNoAxeViolations(page, { minImpact: 'serious' });
      await page.goto('/search');
      await expect(page.getByText('Type what to look for, and press Enter.')).toBeVisible();
      await expectNoAxeViolations(page, { minImpact: 'serious' });
    });

    test('the palette open, with search results and with its commands, has none', async ({ page }) => {
      await page.goto('/c/c1');
      await expect(page.getByRole('treeitem')).toHaveCount(1);
      await page.keyboard.press('Control+k');
      await expect(page.getByRole('option', { name: 'Welcome' })).toBeVisible();
      await expectNoAxeViolations(page, { minImpact: 'serious' });
      await page.getByRole('combobox').fill('roadmap');
      await expect(page.getByRole('option', { name: /Product plan/ })).toBeVisible();
      await expectNoAxeViolations(page, { minImpact: 'serious' });
    });
  });
}

// The highlighted words of a result in forced colours (high contrast): the system's own colours for a marker, which axe must find readable. (The tour's forced-colours specification needs the whole stack;
// this one has the highlights in a result of the scripted search, in the engines that run axe.)
test.describe('forced colours', () => {
  test('/search with highlighted words has no serious or critical violation, and the highlight is drawn in system colours', async ({ page, context }) => {
    await signInAs(context, 'e2e-alice', 'member', { check: false });
    await page.emulateMedia({ forcedColors: 'active' });
    await mockApi(page, { collections: [{ id: 'c1', name: 'Dev', myPermission: 'read-write' }], pages: [] });
    await scriptedSearch(page, () => ({
      items: [
        hit('r1', 'r1000000', 'Product plan', 'the roadmap for the next quarter, the roadmap again', [
          [4, 11],
          [38, 45],
        ]),
      ],
    }));
    await page.goto('/search?q=roadmap');
    await expect(page.getByRole('link', { name: 'Product plan' })).toBeVisible();
    expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches), 'forced colours are on').toBe(true);
    await expect(page.locator('.search-snippet mark')).toHaveCount(2);
    await expectNoAxeViolations(page, { minImpact: 'serious' });
  });
});
