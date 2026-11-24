import { expect, type Locator, type Page } from '@playwright/test';
import { axeViolations, type AxeViolation } from '../support/axe';

export const SCHEMES = ['light', 'dark'] as const;

/** What axe found on one stop of a tour, counted by impact. */
export interface StopReport {
  readonly stop: string;
  readonly scheme: (typeof SCHEMES)[number];
  readonly violations: readonly AxeViolation[];
}

/** The line a report becomes in a pull request: `route (scheme): n serious or critical, m moderate or minor`. */
export function summaryLine(report: StopReport): string {
  const blocking = report.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').length;
  return `${report.stop} (${report.scheme}): ${blocking} serious or critical, ${report.violations.length - blocking} moderate or minor`;
}

/** Runs axe on the page in the light and in the dark scheme (one visit: the scheme is a media query), and returns what it found, minor findings included. */
export async function axeBothSchemes(page: Page, stop: string): Promise<StopReport[]> {
  const reports: StopReport[] = [];
  try {
    for (const scheme of SCHEMES) {
      // Reduced motion with the scheme: the colours of a button change over 120 ms when the scheme changes, and axe measuring in the middle of that sees colours that are neither.
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)).then(() => undefined));
      reports.push({ stop, scheme, violations: await axeViolations(page, { minImpact: 'minor' }) });
    }
  } finally {
    await page.emulateMedia({ colorScheme: null, reducedMotion: null });
  }
  return reports;
}

/** The reports that break the rule (serious or critical), as one readable text: empty when the tour is clean. */
export function blockingText(reports: readonly StopReport[]): string {
  return reports
    .map((r) => ({ r, bad: r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical') }))
    .filter(({ bad }) => bad.length > 0)
    .map(({ r, bad }) => `${r.stop} (${r.scheme}):\n${bad.map((v) => `  ${v.impact} ${v.id}: ${v.help} (${v.targets.join('; ')})`).join('\n')}`)
    .join('\n');
}

/**
 * Every page of the context counts the pointer events it gets: a mouse or pointer press or release, and a click that a pointer made (a key makes a click with `detail` 0).
 * The count is kept in `sessionStorage`, so a walk that loads a page again keeps it.
 */
export const POINTER_COUNTER = '__pointerEvents';
export const COUNT_POINTER_EVENTS = `(() => {
  const bump = () => { try { sessionStorage.setItem('${POINTER_COUNTER}', String(Number(sessionStorage.getItem('${POINTER_COUNTER}') ?? 0) + 1)); } catch { /* a document with no storage */ } };
  for (const type of ['pointerdown', 'mousedown', 'mouseup']) window.addEventListener(type, bump, true);
  window.addEventListener('click', (event) => { if (event.detail > 0) bump(); }, true);
})();`;

/** The number of pointer events the page has had in this session: a keyboard-only walk expects 0. */
export const pointerEvents = (page: Page): Promise<number> => page.evaluate((key) => Number(sessionStorage.getItem(key) ?? 0), POINTER_COUNTER);

/**
 * Presses Tab until the focus is on `target` (at most `limit` times; the focus is checked once more after the last press). It first waits for the target to be on the page and
 * visible: a screen that is still being drawn is not a Tab walk that failed. When the focus never gets there, the error says whether the target is there (its tag, `tabindex`,
 * whether it is disabled, hidden from assistive technology or inert) and which elements the focus went over: a target that is there and skipped is a finding.
 */
export async function tabTo(page: Page, target: Locator, options: { limit?: number; timeout?: number } = {}): Promise<void> {
  const limit = options.limit ?? 60;
  try {
    await target.first().waitFor({ state: 'visible', timeout: options.timeout ?? 10_000 });
  } catch {
    throw new Error(`the element to Tab to is not on the page, or not visible: ${String(target)}`);
  }
  const reached = (): Promise<boolean> => target.evaluateAll((elements) => (elements as Element[]).includes(document.activeElement as Element));
  const here = (): Promise<string> =>
    page.evaluate(() => `${document.activeElement?.tagName.toLowerCase() ?? 'nothing'} "${(document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent ?? '').trim().slice(0, 30)}"`);
  const seen: string[] = [];
  for (let i = 0; i < limit; i += 1) {
    if (await reached()) return;
    const at = await here();
    if (!seen.includes(at)) seen.push(at);
    await page.keyboard.press('Tab');
  }
  if (await reached()) return;
  const state = await target.first().evaluate((element) => {
    const html = element as HTMLElement & { disabled?: boolean };
    const tabindex = element.getAttribute('tabindex');
    return `<${element.tagName.toLowerCase()}${tabindex === null ? '' : ` tabindex="${tabindex}"`}${html.disabled === true ? ' disabled' : ''}${element.closest('[aria-hidden="true"]') === null ? '' : ' inside aria-hidden'}${element.closest('[inert]') === null ? '' : ' inside inert'}>`;
  });
  throw new Error(`the focus never reached ${String(target)} in ${limit} Tab presses: the element is there, ${state}, and Tab skips it (the focus is on ${await here()}; it went over: ${seen.slice(0, 12).join(', ')})`);
}

/** The element is the one the person has the focus on. */
export const focusedLabel = (page: Page): Promise<string | null> => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent ?? null);

export async function headingVisible(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
}

/** The elements of the page (and their `::before` and `::after`) whose transition or animation lasts: `tag.class (transition 0.12s, animation 0s)`, at most 20. */
export async function lastingMotion(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const seconds = (value: string): number[] => value.split(',').map((part) => (part.trim().endsWith('ms') ? parseFloat(part) / 1000 : parseFloat(part)));
    const found: string[] = [];
    for (const element of document.querySelectorAll('*')) {
      for (const pseudo of [null, '::before', '::after']) {
        const style = getComputedStyle(element, pseudo);
        const transition = Math.max(0, ...seconds(style.transitionDuration));
        const animation = Math.max(0, ...seconds(style.animationDuration));
        if (transition > 0 || animation > 0)
          found.push(
            `${element.tagName.toLowerCase()}.${String((element as HTMLElement).className)
              .trim()
              .replace(/\s+/g, '.')}${pseudo ?? ''} (transition ${transition}s, animation ${animation}s)`,
          );
      }
    }
    return found.slice(0, 20);
  });
}
