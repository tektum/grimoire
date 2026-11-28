import { expect, test, type Page } from '@playwright/test';
import { API } from '../collections/mock-api';
import { historyApi, SLUG } from '../history/mock-api';
import { signInAs } from '../support/sign-in';
import { fits, measure, record, shot, stable } from './audit';
import { HISTORY, MARKDOWN, open, VISITS } from './world';

// The overlays (palette, page menu, reset dialog, restore confirmation) on a page whose text fits the phone, beside the same on the page whose table and
// address make it wider than the phone: which misplacements are the overlays' own, and which come from the page being wider than the screen.
const CLEAN = MARKDOWN.split('\n').filter((line) => !line.startsWith('|') && !line.startsWith('A long address')).join('\n');

const metrics = (page: Page) =>
  page.evaluate(() => ({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    visual: window.visualViewport === null ? null : { width: Math.round(window.visualViewport.width), height: Math.round(window.visualViewport.height), scale: window.visualViewport.scale },
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    mainWidth: Math.round(document.querySelector('main')?.getBoundingClientRect().width ?? 0),
    headerHeight: Math.round(document.querySelector('.shell-header')?.getBoundingClientRect().height ?? 0),
    bodyStyle: document.body.getAttribute('style'),
  }));

for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 568 }]) {
  test.describe(`overlays at ${String(viewport.width)}`, () => {
    test.use({ viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
    for (const variant of ['clean', 'wide'] as const) {
      test(`${variant} page`, async ({ page, context }) => {
        const out: Record<string, unknown> = {};
        const markdown = variant === 'clean' ? CLEAN : MARKDOWN;
        await open(page, context, {
          ...VISITS.find((v) => v.slug === 'page')!,
          setup: async (p, c) => {
            await signInAs(c, 'e2e-alice', 'admin', { check: false });
            await historyApi(p, { ...HISTORY, role: 'admin', current: markdown, revisions: HISTORY.revisions.map((r) => ({ ...r, markdown: variant === 'clean' ? CLEAN.replace('Paragraph 2 of the notes', 'The older wording of paragraph 2') : r.markdown })) });
            await p.route(`${API}/v1/pages/*/reset-state`, (route) => {
              const request = route.request();
              const cors = { 'access-control-allow-origin': request.headers()['origin'] ?? '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
              if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
              return route.fulfill({ status: 409, contentType: 'application/json', headers: cors, body: JSON.stringify({ error: { code: 'markdown_stale', message: 'x' } }) });
            });
          },
        });
        out['loaded'] = await metrics(page);
        await page.getByRole('button', { name: 'More page actions' }).click();
        await expect(page.getByRole('menu')).toBeVisible();
        await stable(page, '[role=menu]');
        out['menuOpen'] = { metrics: await metrics(page), fit: await fits(page, '[role=menu]') };
        await shot(page, `overlay-${variant}-menu`, { fullPage: false, themes: ['light'] });
        await page.getByRole('menuitem', { name: /Reset saved state/ }).click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await stable(page, '[role=dialog]');
        out['reset'] = { metrics: await metrics(page), fit: await fits(page, '[role=dialog]'), small: (await measure(page, '[role=dialog]')).smallTargets };
        await shot(page, `overlay-${variant}-reset`, { fullPage: false, themes: ['light'] });
        await page.getByRole('button', { name: 'Reset state' }).click();
        await expect(page.getByRole('alertdialog')).toBeVisible();
        await stable(page, '[role=alertdialog]');
        out['resetStale'] = { fit: await fits(page, '[role=alertdialog]') };
        await shot(page, `overlay-${variant}-reset-stale`, { fullPage: false, themes: ['light'] });
        await page.getByRole('button', { name: 'Cancel' }).click();
        await expect(page.getByRole('alertdialog')).toBeHidden();
        await page.keyboard.press('Control+k');
        await expect(page.locator('.modal.palette')).toBeVisible();
        await page.getByRole('combobox').fill('plan');
        await expect(page.locator('.modal.palette')).toBeVisible();
        await stable(page, '.modal.palette');
        out['palette'] = { metrics: await metrics(page), fit: await fits(page, '.modal.palette') };
        await shot(page, `overlay-${variant}-palette`, { fullPage: false, themes: ['light'] });
        await page.keyboard.press('Escape');
        await page.goto(`/p/${SLUG}/history/r3`);
        await expect(page.getByTestId('revision-text').locator('.ProseMirror')).toContainText('older wording');
        await page.getByRole('button', { name: 'Restore this version' }).click();
        await expect(page.getByRole('alertdialog')).toBeVisible();
        await stable(page, '[role=alertdialog]');
        out['restore'] = { metrics: await metrics(page), fit: await fits(page, '[role=alertdialog]') };
        await shot(page, `overlay-${variant}-restore`, { fullPage: false, themes: ['light'] });
        record(`${String(viewport.width)}-overlay-${variant}`, out);
      });
    }
  });
}
