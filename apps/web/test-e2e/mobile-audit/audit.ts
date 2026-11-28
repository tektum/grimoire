import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { shotsDir } from '../support/shots';

// Measurements for the phone-viewport audit. Every visit writes what it measured as JSON under `E2E_AUDIT_DIR` (default test-results/mobile-audit), and full-page
// screenshots under the usual shots folder, and the colour and height checks below assert what the system promises on a phone.

export const TASK = 'mobile-audit';
/** Where the measurements go: `E2E_AUDIT_DIR`, or `test-results/mobile-audit` under the repository (a run writes only there). */
export const RESULTS = process.env['E2E_AUDIT_DIR'] ?? path.join(process.cwd(), 'test-results', 'mobile-audit');
/** The interface face the other screenshot specs name: this machine's default sans-serif is a monospace face. */
export const SANS = ":root { --font-ui: 'Liberation Sans', Arial, sans-serif; } [data-sonner-toaster] { font-family: 'Liberation Sans', Arial, sans-serif; }";

export const THEMES = ['light', 'dark'] as const;

export async function shot(page: Page, name: string, options: { fullPage?: boolean; themes?: readonly ('light' | 'dark')[] } = {}): Promise<string[]> {
  const width = page.viewportSize()?.width ?? 0;
  const files: string[] = [];
  const dir = shotsDir(TASK);
  mkdirSync(dir, { recursive: true });
  for (const theme of options.themes ?? THEMES) {
    await page.emulateMedia({ colorScheme: theme });
    const file = path.join(dir, `${name}-${String(width)}-${theme}.png`);
    await page.screenshot({ path: file, fullPage: options.fullPage ?? true, animations: 'disabled', scale: 'css', mask: [page.locator('input[type="password"]')], maskColor: '#808080' });
    files.push(file);
  }
  await page.emulateMedia({ colorScheme: 'light' });
  return files;
}

/**
 * Waits until the box of `selector` has stopped changing: a popover's entrance (120-180 ms of transform and opacity) is over, so what is measured is where it
 * came to rest. A condition, not a sleep: it returns as soon as the box holds still, and it fails when the element never settles.
 */
export async function stable(page: Page, selector: string): Promise<void> {
  await page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel);
      if (el === null) return false;
      const r = el.getBoundingClientRect();
      const key = `${sel}:${String(Math.round(r.left))},${String(Math.round(r.top))},${String(Math.round(r.width))},${String(Math.round(r.height))}`;
      const seen = (window as unknown as { __auditStable?: { key: string; n: number } }).__auditStable;
      if (seen !== undefined && seen.key === key && seen.n >= 2) return true;
      (window as unknown as { __auditStable?: { key: string; n: number } }).__auditStable = { key, n: seen !== undefined && seen.key === key ? seen.n + 1 : 1 };
      return false;
    },
    selector,
    { polling: 'raf' },
  );
}

export function record(name: string, data: unknown): void {
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(path.join(RESULTS, `${name}.json`), JSON.stringify(data, null, 2));
}

export interface Measured {
  viewport: { width: number; height: number };
  scrollWidth: number;
  clientWidth: number;
  overflowPx: number;
  offenders: { el: string; text: string; width: number; left: number; right: number }[];
  clipped: { el: string; text: string; kind: string; clientWidth: number; scrollWidth: number }[];
  smallTargets: { el: string; name: string; width: number; height: number; effW: number; effH: number; inline: boolean }[];
  targetCount: number;
}

/**
 * Measures, in the page: sideways overflow of the document and its widest offenders, boxes whose content is wider than they are, interactive elements under 44 by 44,
 * and elements whose box leaves the viewport. `scope` limits the target and clip checks to one subtree (a dialog), when given.
 */
export async function measure(page: Page, scope?: string): Promise<Measured> {
  return page.evaluate((scopeSel) => {
    const vw = document.documentElement.clientWidth;
    const describe = (el: Element): string => {
      const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 3).join('.') : '';
      const id = el.id === '' ? '' : `#${el.id}`;
      return `${el.tagName.toLowerCase()}${id}${cls === '' ? '' : `.${cls}`}`;
    };
    const textOf = (el: Element): string => ((el as HTMLElement).innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
    /** Out of the page for everyone: aria-hidden, inert, display none, visibility hidden, or a 1px screen-reader-only box. */
    const hiddenFromAll = (el: Element): boolean => el.closest('[aria-hidden="true"], [inert]') !== null;
    const visible = (el: Element): boolean => {
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse' || Number(s.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1) return false;
      return (el as HTMLElement).checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? true;
    };
    /** Clipped by an ancestor that does not let it show (overflow hidden, clip, auto or scroll): its overflow is that box's business, not the page's. */
    const clippedByAncestor = (el: Element): boolean => {
      for (let up = el.parentElement; up !== null && up !== document.body && up !== document.documentElement; up = up.parentElement) {
        const ox = getComputedStyle(up).overflowX;
        if (ox !== 'visible') {
          const r = up.getBoundingClientRect();
          if (r.right <= vw + 0.5 && r.left >= -0.5) return true;
        }
      }
      return false;
    };
    const root = scopeSel === undefined ? document.body : (document.querySelector(scopeSel) ?? document.body);
    const all = Array.from(document.body.querySelectorAll('*'));
    const offenders: Measured['offenders'] = [];
    const offending = new Set<Element>();
    for (const el of all) {
      if (hiddenFromAll(el) || !visible(el)) continue;
      const r = el.getBoundingClientRect();
      const sx = window.scrollX;
      const left = r.left + sx;
      const right = r.right + sx;
      if ((right > vw + 0.5 || left < -0.5) && !clippedByAncestor(el)) offending.add(el);
    }
    for (const el of offending) {
      if (el.parentElement !== null && offending.has(el.parentElement)) continue; // the outermost only
      const r = el.getBoundingClientRect();
      offenders.push({ el: describe(el), text: textOf(el), width: Math.round(r.width), left: Math.round(r.left + window.scrollX), right: Math.round(r.right + window.scrollX) });
    }
    offenders.sort((a, b) => b.right - a.right);

    const clipped: Measured['clipped'] = [];
    for (const el of Array.from(root.querySelectorAll('*'))) {
      if (hiddenFromAll(el) || !visible(el)) continue;
      const h = el as HTMLElement;
      if (h.scrollWidth <= h.clientWidth + 1 || h.clientWidth === 0) continue;
      const s = getComputedStyle(el);
      if (['svg', 'path', 'g'].includes(el.tagName.toLowerCase())) continue;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) continue;
      let kind: string;
      if (s.overflowX === 'auto' || s.overflowX === 'scroll') kind = 'scrolls sideways';
      else if (s.overflowX === 'hidden' || s.overflowX === 'clip') kind = s.textOverflow === 'ellipsis' ? 'cut with ellipsis' : 'cut without ellipsis';
      else {
        // overflow visible: only a box whose own text spills is of interest (a wrapper of a wide child is caught at the child).
        const hasText = Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== '');
        if (!hasText) continue;
        kind = 'text spills out of its box';
      }
      clipped.push({ el: describe(el), text: textOf(el), kind, clientWidth: h.clientWidth, scrollWidth: h.scrollWidth });
    }

    const nameOf = (el: Element): string => {
      const h = el as HTMLElement;
      const aria = el.getAttribute('aria-label');
      if (aria) return aria;
      const by = el.getAttribute('aria-labelledby');
      if (by) return by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim();
      if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
        const label = el.labels?.[0];
        if (label) return label.textContent?.replace(/\s+/g, ' ').trim() ?? '';
        if (el instanceof HTMLInputElement && el.placeholder) return el.placeholder;
      }
      const text = (h.innerText ?? '').replace(/\s+/g, ' ').trim();
      if (text) return text.slice(0, 50);
      return el.getAttribute('title') ?? '';
    };
    const SEL = 'a[href], button, [role=button], input:not([type=hidden]), select, textarea, summary, [role=menuitem], [role=tab], [role=treeitem], [role=option], [role=radio], [role=checkbox]';
    const smallTargets: Measured['smallTargets'] = [];
    let targetCount = 0;
    for (const el of Array.from(root.querySelectorAll(SEL))) {
      if (hiddenFromAll(el)) continue;
      const r = el.getBoundingClientRect();
      // A radio, a checkbox or a file chooser counts with its label (a tap on the label works it); a text field or a select counts by its own box.
      let box = r;
      const labelled = el instanceof HTMLInputElement && ['radio', 'checkbox', 'file'].includes(el.type);
      const labels = labelled ? Array.from((el as HTMLInputElement).labels ?? []) : [];
      const shown = visible(el);
      if (!shown && labels.length === 0) continue;
      let effW = shown ? r.width : 0;
      let effH = shown ? r.height : 0;
      for (const label of labels) {
        if (!visible(label)) continue;
        const lr = label.getBoundingClientRect();
        // the label and the input together, when the label holds the input or sits beside it
        const left = Math.min(shown ? r.left : lr.left, lr.left);
        const right = Math.max(shown ? r.right : lr.right, lr.right);
        const top = Math.min(shown ? r.top : lr.top, lr.top);
        const bottom = Math.max(shown ? r.bottom : lr.bottom, lr.bottom);
        effW = Math.max(effW, right - left);
        effH = Math.max(effH, bottom - top);
        if (!shown) box = lr;
      }
      if (effW <= 1 || effH <= 1) continue;
      if (r.bottom + window.scrollY <= 0 || r.right + window.scrollX <= 0) continue; // off-screen until focused (the skip link)
      targetCount += 1;
      const s = getComputedStyle(el);
      const parentText = el.parentElement === null ? '' : (el.parentElement.textContent ?? '').trim();
      // WCAG 2.5.8's inline exception: a link inside a sentence of running text, not a title or a row on its own.
      const inline = el.tagName === 'A' && s.display === 'inline' && el.closest('p') !== null && parentText.length > (el.textContent ?? '').trim().length + 10;
      if (effW < 43.5 || effH < 43.5) smallTargets.push({ el: describe(el), name: nameOf(el), width: Math.round(box.width), height: Math.round(box.height), effW: Math.round(effW), effH: Math.round(effH), inline });
    }
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: vw,
      overflowPx: Math.max(0, document.documentElement.scrollWidth - vw),
      offenders: offenders.slice(0, 12),
      clipped: clipped.slice(0, 30),
      smallTargets,
      targetCount,
    };
  }, scope);
}

export interface HeaderCheck {
  scrollable: boolean;
  scrolledBy: number;
  header: { top: number; bottom: number; position: string; background: string } | null;
  /** Headings partly under the header after scrolling 400px. */
  underAfterScroll: { text: string; top: number; bottom: number }[];
  /** After `scrollIntoView` of the first heading in main (what an anchor or focus does): its top against the header's bottom. */
  intoView: { text: string; top: number; headerBottom: number; hidden: boolean } | null;
}

export async function headerCheck(page: Page): Promise<HeaderCheck> {
  return page.evaluate(async () => {
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const header = document.querySelector('.shell-header');
    const scrollable = document.documentElement.scrollHeight > window.innerHeight + 4;
    window.scrollTo(0, 400);
    await frame();
    const scrolledBy = window.scrollY;
    const hr = header?.getBoundingClientRect();
    const hs = header === null ? null : getComputedStyle(header);
    const headings = Array.from(document.querySelectorAll('main h1, main h2, main h3, main h4'));
    const underAfterScroll = hr === undefined ? [] : headings.map((h) => ({ text: (h.textContent ?? '').trim().slice(0, 40), r: h.getBoundingClientRect() })).filter(({ r }) => r.height > 0 && r.top < hr.bottom - 1 && r.bottom > hr.top + 1).map(({ text, r }) => ({ text, top: Math.round(r.top), bottom: Math.round(r.bottom) }));
    // The deepest heading that is below the fold at the start (else the first): scrolled into view as an anchor would.
    const target = headings.find((h) => h.getBoundingClientRect().top + window.scrollY > window.innerHeight) ?? headings[0];
    let intoView: HeaderCheck['intoView'] = null;
    if (target !== undefined && hr !== undefined) {
      window.scrollTo(0, 0);
      await frame();
      target.scrollIntoView({ block: 'start' });
      await frame();
      const hb = header!.getBoundingClientRect().bottom;
      const top = target.getBoundingClientRect().top;
      intoView = { text: (target.textContent ?? '').trim().slice(0, 40), top: Math.round(top), headerBottom: Math.round(hb), hidden: top < hb - 1 && window.scrollY > 0 };
    }
    window.scrollTo(0, 0);
    await frame();
    return {
      scrollable,
      scrolledBy,
      header: hr === undefined || hs === null ? null : { top: Math.round(hr.top), bottom: Math.round(hr.bottom), position: hs.position, background: hs.backgroundColor },
      underAfterScroll,
      intoView,
    };
  });
}

export async function boxOf(locator: Locator): Promise<{ x: number; y: number; width: number; height: number } | null> {
  const b = await locator.boundingBox().catch(() => null);
  return b === null ? null : { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
}

/** A panel's box against the viewport: whether it fits. */
export async function fits(page: Page, selector: string): Promise<{ selector: string; box: { left: number; right: number; top: number; bottom: number; width: number; height: number } | null; vw: number; vh: number; fitsWidth: boolean; fitsHeight: boolean; scrollWidth: number; clientWidth: number; scrollHeight: number; clientHeight: number }> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    if (el === null) return { selector: sel, box: null, vw, vh, fitsWidth: false, fitsHeight: false, scrollWidth: 0, clientWidth: 0, scrollHeight: 0, clientHeight: 0 };
    const r = el.getBoundingClientRect();
    return {
      selector: sel,
      box: { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), width: Math.round(r.width), height: Math.round(r.height) },
      vw,
      vh,
      fitsWidth: r.left >= -0.5 && r.right <= vw + 0.5 && el.scrollWidth <= el.clientWidth + 1,
      fitsHeight: r.top >= -0.5 && r.bottom <= vh + 0.5 && el.scrollHeight <= el.clientHeight + 1,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    };
  }, selector);
}
