import { expect, test, type Page } from '@playwright/test';
import { API } from '../collections/mock-api';
import { historyApi } from '../history/mock-api';
import { signInAs } from '../support/sign-in';
import { hit, scriptedSearch } from '../search/support';
import { boxOf, fits, headerCheck, measure, record, shot, stable } from './audit';
import { HISTORY, open, VISITS } from './world';

// The phone audit: every route of a11y/routes.ts at 390 by 844 and 320 by 568 with touch, light and dark, against the stand-ins of the API and of collaboration
// (never the stack: `mockApi` and its siblings answer the requests, `scriptedCollabServer` speaks the wire). Full-page shots go to
// test-results/shots/mobile-audit/, measurements to `E2E_AUDIT_DIR` (default test-results/mobile-audit); the report they feed is findings.md here. The audit
// records rather than asserts; the phone promises the system makes are asserted in phone.spec.ts, scroll-lock.spec.ts and (on the stack) live-editor.spec.ts. Run:
// bunx playwright test -c apps/web/playwright.config.ts --project=chromium test-e2e/mobile-audit

const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 320, height: 568 },
] as const;

/** Every visible interactive element of the shell header, with its box, and the pairs that overlap. */
async function headerControls(page: Page) {
  return page.evaluate(() => {
    const header = document.querySelector('.shell-header');
    if (header === null) return null;
    const controls = Array.from(header.querySelectorAll('a[href], button, [role=button]'))
      .filter((el) => el.closest('[aria-hidden="true"], [inert]') === null)
      .map((el) => ({ el, r: el.getBoundingClientRect(), s: getComputedStyle(el) }))
      .filter(({ r, s }) => r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none')
      .map(({ el, r }) => ({ name: el.getAttribute('aria-label') ?? (el as HTMLElement).innerText.trim().slice(0, 40), left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }));
    const overlaps: string[] = [];
    for (let i = 0; i < controls.length; i += 1)
      for (let j = i + 1; j < controls.length; j += 1) {
        const a = controls[i]!;
        const b = controls[j]!;
        const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const y = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
        if (x > 0.5 && y > 0.5) overlaps.push(`${a.name} / ${b.name}: ${String(x)}x${String(y)}`);
      }
    const hr = header.getBoundingClientRect();
    return { header: { height: Math.round(hr.height), width: Math.round(hr.width) }, controls, overlaps };
  });
}

/** The phone controls: the contents button and the menu button, each opened, measured and closed. */
async function phoneControls(page: Page, slug: string) {
  const out: Record<string, unknown> = {};
  for (const [key, open, close, panel] of [
    ['contents', 'Show contents', 'Hide contents', '#shell-contents'],
    ['menu', 'Show menu', 'Hide menu', '#shell-actions'],
  ] as const) {
    const button = page.getByRole('button', { name: open, exact: true });
    if (!(await button.isVisible().catch(() => false))) {
      out[key] = { present: false };
      continue;
    }
    const box = await boxOf(button);
    await button.click();
    await expect(page.locator(panel)).toBeVisible();
    await stable(page, panel);
    const fit = await fits(page, panel);
    const inside = await measure(page, panel);
    if (['page', 'collection', 'admin-users'].includes(slug)) await shot(page, `${slug}-${key}-open`, { fullPage: false });
    await page.getByRole('button', { name: close, exact: true }).click();
    await expect(page.locator(panel)).toBeHidden();
    out[key] = { present: true, button: box, panel: fit, overflowWithPanelOpen: inside.overflowPx, offenders: inside.offenders, smallTargets: inside.smallTargets, clipped: inside.clipped };
  }
  return out;
}

/** What the design review asked about, per screen. */
async function extras(page: Page, slug: string): Promise<Record<string, unknown>> {
  if (slug === 'admin-users') {
    return {
      users: await page.evaluate(() =>
        Array.from(document.querySelectorAll('main li')).map((li) => {
          const r = li.getBoundingClientRect();
          const select = li.querySelector('select');
          const buttons = Array.from(li.querySelectorAll('button'));
          const sr = select?.getBoundingClientRect();
          const label = select?.labels?.[0] ?? null;
          const lr = label?.getBoundingClientRect();
          const visibleText = Array.from(li.querySelectorAll('*')).filter((e) => e.children.length === 0 && (e.textContent ?? '').trim() === 'Role').map((e) => { const b = e.getBoundingClientRect(); return { top: Math.round(b.top - r.top), height: Math.round(b.height), width: Math.round(b.width) }; });
          return {
            text: (li as HTMLElement).innerText.replace(/\s+/g, ' ').slice(0, 80),
            height: Math.round(r.height),
            select: sr === undefined ? null : { top: Math.round(sr.top - r.top), height: Math.round(sr.height), width: Math.round(sr.width), bottom: Math.round(sr.bottom - r.top) },
            selectLabel: lr === undefined ? null : { text: label?.textContent?.trim(), top: Math.round(lr.top - r.top), height: Math.round(lr.height), width: Math.round(lr.width), hidden: lr.width <= 1 },
            roleWord: visibleText,
            buttons: buttons.map((b) => { const br = b.getBoundingClientRect(); return { name: b.getAttribute('aria-label') ?? b.innerText, top: Math.round(br.top - r.top), height: Math.round(br.height), width: Math.round(br.width), bottom: Math.round(br.bottom - r.top) }; }),
            // centre-line offset between the role select and the first button
            centreOffset: sr === undefined || buttons[0] === undefined ? null : Math.round(((sr.top + sr.bottom) / 2 - (buttons[0].getBoundingClientRect().top + buttons[0].getBoundingClientRect().bottom) / 2) * 10) / 10,
          };
        }),
      ),
    };
  }
  if (slug === 'collection' || slug === 'home') {
    return {
      switcher: await page.evaluate(() => {
        const nav = document.querySelector('nav[aria-label="Collections"]');
        if (nav === null) return null;
        return Array.from(nav.querySelectorAll('a, button')).map((a) => {
          const r = a.getBoundingClientRect();
          const s = getComputedStyle(a);
          return { tag: a.tagName.toLowerCase(), text: (a as HTMLElement).innerText.trim(), current: a.getAttribute('aria-current'), width: Math.round(r.width), height: Math.round(r.height), background: s.backgroundColor, border: s.borderStyle + ' ' + s.borderWidth, underline: s.textDecorationLine, cursor: s.cursor, display: s.display };
        });
      }),
    };
  }
  if (slug === 'admin-access') {
    return {
      table: await page.evaluate(() => {
        const table = document.querySelector('table');
        if (table === null) return null;
        const parent = table.parentElement as HTMLElement;
        const tr = table.getBoundingClientRect();
        const s = getComputedStyle(parent);
        return { tableWidth: Math.round(tr.width), tableRight: Math.round(tr.right), container: `${parent.tagName.toLowerCase()}.${parent.className}`, containerClient: parent.clientWidth, containerScroll: parent.scrollWidth, containerOverflowX: s.overflowX, pageScrollWidth: document.documentElement.scrollWidth, pageClient: document.documentElement.clientWidth,
          columns: Array.from(table.querySelectorAll('tr:first-child > *')).map((c) => Math.round(c.getBoundingClientRect().width)),
          controls: Array.from(document.querySelectorAll('main select, main button, main input')).map((c) => { const r = c.getBoundingClientRect(); return { name: c.getAttribute('aria-label') ?? (c as HTMLElement).innerText ?? '', tag: c.tagName.toLowerCase(), width: Math.round(r.width), height: Math.round(r.height), right: Math.round(r.right) }; }) };
      }),
    };
  }
  if (slug === 'trash' || slug === 'admin-groups' || slug === 'collections-new' || slug.startsWith('import')) {
    return {
      controls: await page.evaluate(() => Array.from(document.querySelectorAll('main select, main button, main input, main textarea')).map((c) => { const r = c.getBoundingClientRect(); return { name: c.getAttribute('aria-label') ?? (c as HTMLElement).innerText ?? (c as HTMLInputElement).type, tag: c.tagName.toLowerCase(), type: (c as HTMLInputElement).type, width: Math.round(r.width), height: Math.round(r.height) }; })),
    };
  }
  return {};
}

for (const viewport of VIEWPORTS) {
  test.describe(`at ${String(viewport.width)} by ${String(viewport.height)}`, () => {
    test.use({ viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
    test.beforeEach(({ browserName }) => { test.skip(browserName !== 'chromium', 'the audit runs in Chromium'); });

    for (const visit of VISITS) {
      test(`${visit.slug} (${visit.route})`, async ({ page, context }) => {
        await open(page, context, visit);
        const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches);
        const measured = await measure(page);
        await shot(page, visit.slug);
        const header = await headerCheck(page);
        const bar = await headerControls(page);
        const extra = await extras(page, visit.slug);
        const phone = await phoneControls(page, visit.slug);
        record(`${String(viewport.width)}-${visit.slug}`, { route: visit.route, path: visit.path, coarse, ...measured, header, bar, phone, extra });
        expect(coarse).toBe(true);
      });
    }

    test('surfaces: contents drawer, palette, account menu, page actions menu, reset dialog', async ({ page, context }) => {
      const visit = VISITS.find((v) => v.slug === 'page')!;
      await open(page, context, visit);
      await scriptedSearch(page, () => ({
        items: [
          hit('s1', 's1000000', 'Quarterly plan', 'Goals for the quarter: the plan for search first, then import.', [[26, 30]]),
          hit('s2', 's2000000', 'Plan for May in the engineering handbook and runbooks', 'Before each release, check the plan and the open questions.', [[32, 36]]),
        ],
      }));
      const out: Record<string, unknown> = {};
      // The contents drawer, then its Search button: the palette.
      await page.getByRole('button', { name: 'Show contents', exact: true }).click();
      await stable(page, '#shell-contents');
      out['contents'] = { fit: await fits(page, '#shell-contents'), m: await measure(page, '#shell-contents') };
      await shot(page, 'surface-contents', { fullPage: false });
      await page.locator('.contents-search').click();
      const palette = page.locator('.modal.palette');
      await expect(palette).toBeVisible();
      await page.getByRole('combobox').fill('plan');
      await expect(page.getByRole('option').first()).toBeVisible();
      await stable(page, '.modal.palette');
      const paletteRows = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[cmdk-item]')).map((row) => {
          const label = row.querySelector('.palette-label') as HTMLElement | null;
          const path = row.querySelector('.palette-path') as HTMLElement | null;
          const r = row.getBoundingClientRect();
          return {
            label: label?.innerText ?? '',
            labelCut: label === null ? false : label.scrollWidth > label.clientWidth + 1,
            path: path?.innerText ?? null,
            pathCut: path === null ? false : path.scrollWidth > path.clientWidth + 1,
            ellipses: ((label?.innerText ?? '') + (path?.innerText ?? '')).split('\u2026').length - 1,
            height: Math.round(r.height),
            width: Math.round(r.width),
          };
        }),
      );
      out['palette'] = { fit: await fits(page, '.modal.palette'), m: await measure(page, '.modal.palette'), rows: paletteRows, overflow: (await measure(page)).overflowPx };
      await shot(page, 'surface-palette', { fullPage: false });
      await page.keyboard.press('Escape');
      await expect(palette).toBeHidden();
      // The account menu.
      await page.getByRole('button', { name: 'Show menu', exact: true }).click();
      await stable(page, '#shell-actions');
      out['account'] = { fit: await fits(page, '#shell-actions'), m: await measure(page, '#shell-actions') };
      const colours = async () => page.evaluate(() => {
        const parse = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
        const lum = (c: number[]) => { const [r, g, b] = c.slice(0, 3).map((v) => { const s = v > 1 ? v / 255 : v; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!; };
        const panel = document.querySelector('#shell-actions')!;
        const bg = parse(getComputedStyle(panel).backgroundColor);
        return Array.from(panel.querySelectorAll('a, button, [data-testid]')).map((a) => {
          const s = getComputedStyle(a);
          const fg = parse(s.color);
          const [l1, l2] = [lum(fg), lum(bg)].sort((x, y) => y - x);
          return { text: (a as HTMLElement).innerText.trim().slice(0, 20), color: s.color, background: getComputedStyle(panel).backgroundColor, fontSize: s.fontSize, contrast: Math.round(((l1! + 0.05) / (l2! + 0.05)) * 100) / 100 };
        });
      });
      out['accountColours'] = { light: await colours() };
      await page.emulateMedia({ colorScheme: 'dark' });
      (out['accountColours'] as Record<string, unknown>)['dark'] = await colours();
      await page.emulateMedia({ colorScheme: 'light' });
      await shot(page, 'surface-account-menu', { fullPage: false });
      await page.getByRole('button', { name: 'Hide menu', exact: true }).click();
      out['bar'] = await headerControls(page);
      record(`${String(viewport.width)}-surfaces-member`, out);
    });

    test('surfaces as an admin: page actions menu, reset dialog and its stale confirmation', async ({ page, context }) => {
      const { history } = { history: VISITS.find((v) => v.slug === 'page')! };
      const out: Record<string, unknown> = {};
      await open(page, context, { ...history, setup: async (p, c) => {
        await signInAs(c, 'e2e-alice', 'admin', { check: false });
        await historyApi(p, { ...HISTORY, role: 'admin' });
        await p.route(`${API}/v1/pages/*/reset-state`, (route) => {
          const request = route.request();
          const cors = { 'access-control-allow-origin': request.headers()['origin'] ?? '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
          if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
          return route.fulfill({ status: 409, contentType: 'application/json', headers: cors, body: JSON.stringify({ error: { code: 'markdown_stale', message: 'x' } }) });
        });
      } });
      out['bar'] = await headerControls(page);
      await page.getByRole('button', { name: 'More page actions' }).click();
      const menu = page.getByRole('menu');
      await expect(menu).toBeVisible();
      out['menu'] = { fit: await fits(page, '[role=menu]'), m: await measure(page, '[role=menu]') };
      await shot(page, 'surface-page-actions', { fullPage: false });
      await page.getByRole('menuitem', { name: /Reset saved state/ }).click();
      const dialog = page.getByRole('dialog', { name: /Reset the saved state/ });
      await expect(dialog).toBeVisible();
      await stable(page, '[role=dialog]');
      const buttons = await dialog.evaluate((d) => Array.from(d.querySelectorAll('button, [role=button], a[href]')).map((b) => { const r = b.getBoundingClientRect(); return { name: b.getAttribute('aria-label') ?? (b as HTMLElement).innerText.trim(), width: Math.round(r.width), height: Math.round(r.height) }; }));
      out['reset'] = { fit: await fits(page, '[role=dialog]'), m: await measure(page, '[role=dialog]'), buttons };
      await shot(page, 'surface-reset-dialog', { fullPage: false });
      await dialog.getByRole('button', { name: 'Reset state' }).click();
      const stale = page.getByRole('alertdialog');
      await expect(stale).toBeVisible();
      await stable(page, '[role=alertdialog]');
      const staleButtons = await stale.evaluate((d) => Array.from(d.querySelectorAll('button, [role=button], a[href]')).map((b) => { const r = b.getBoundingClientRect(); return { name: b.getAttribute('aria-label') ?? (b as HTMLElement).innerText.trim(), width: Math.round(r.width), height: Math.round(r.height) }; }));
      out['resetStale'] = { fit: await fits(page, '[role=alertdialog]'), m: await measure(page, '[role=alertdialog]'), buttons: staleButtons };
      await shot(page, 'surface-reset-stale', { fullPage: false });
      record(`${String(viewport.width)}-surfaces-admin`, out);
    });

    test('surfaces of history: the diff and the restore confirmation', async ({ page, context }) => {
      const out: Record<string, unknown> = {};
      await open(page, context, VISITS.find((v) => v.slug === 'revision')!);
      await page.getByRole('tab', { name: 'Changes' }).click();
      await expect(page.getByRole('tabpanel').locator('ins').first()).toBeVisible();
      out['diff'] = await measure(page);
      await shot(page, 'surface-revision-diff');
      await page.getByRole('tab', { name: /Text|Version/ }).first().click().catch(() => undefined);
      await page.getByRole('button', { name: 'Restore this version' }).click();
      const confirm = page.getByRole('alertdialog', { name: 'Restore this version?' });
      await expect(confirm).toBeVisible();
      await stable(page, '[role=alertdialog]');
      const buttons = await confirm.evaluate((d) => Array.from(d.querySelectorAll('button, [role=button], a[href]')).map((b) => { const r = b.getBoundingClientRect(); return { name: b.getAttribute('aria-label') ?? (b as HTMLElement).innerText.trim(), width: Math.round(r.width), height: Math.round(r.height) }; }));
      out['restore'] = { fit: await fits(page, '[role=alertdialog]'), m: await measure(page, '[role=alertdialog]'), buttons };
      await shot(page, 'surface-restore-confirm', { fullPage: false });
      record(`${String(viewport.width)}-surfaces-history`, out);
    });

  });
}
