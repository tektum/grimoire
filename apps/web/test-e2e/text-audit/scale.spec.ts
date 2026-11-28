import { expect, test, type Page } from '@playwright/test';
import { open, VISITS } from '../mobile-audit/world';

// Text scale (HIG "Supporting Dynamic Type", WCAG 1.4.4 and 1.4.10): text at 200% must not clip, overlap or make the page scroll sideways. The page is the one
// the phone audit uses, with a five-column table and a long address that cannot break, at three widths that matter: a desktop, the narrowest window that keeps
// the contents beside the page, and a phone. Against the stand-ins of the API; nothing here needs the stack.
const TEXT_SIZES = [100, 150, 200] as const;
const WIDTHS = [1280, 780, 390] as const;

/** The text at `percent`, and the page redrawn: the font-size change applies at once, and one frame later what is measured is the layout it made. */
async function setTextSize(page: Page, percent: number): Promise<void> {
  await page.addStyleTag({ content: `html { font-size: ${String(percent)}% !important; }` });
  await page.evaluate(() => new Promise<void>((done) => { requestAnimationFrame(() => { requestAnimationFrame(() => { done(); }); }); }));
}

interface Measured {
  readonly overflow: number;
  readonly clipped: readonly string[];
  readonly overlapping: readonly string[];
}

/** Sideways overflow, controls whose text is cut without an ellipsis, and sibling controls of one row whose boxes collide. */
async function measure(page: Page): Promise<Measured> {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const overflow = Math.max(0, doc.scrollWidth - doc.clientWidth);
    const clipped: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('button, a, h1, h2, h3, label, .page-status, select, input')) {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || el.closest('[aria-hidden="true"]') !== null) continue;
      const hides = style.overflow !== 'visible' && style.textOverflow !== 'ellipsis';
      if (hides && el.scrollWidth > el.clientWidth + 1) clipped.push(`${el.tagName.toLowerCase()}.${el.className}: ${String(el.scrollWidth)}>${String(el.clientWidth)}`);
    }
    const overlapping: string[] = [];
    const boxes = [...document.querySelectorAll<HTMLElement>('.shell-header button, .shell-header a, .modal button')]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && r.height > 0);
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i]!.r;
        const b = boxes[j]!.r;
        if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2) {
          overlapping.push(`${(boxes[i]!.el.textContent ?? '').trim().slice(0, 20)} x ${(boxes[j]!.el.textContent ?? '').trim().slice(0, 20)}`);
        }
      }
    }
    return { overflow, clipped, overlapping };
  });
}

for (const width of WIDTHS) {
  test(`the page at 200% text, ${String(width)}px wide: no sideways scroll and no clipped control`, async ({ page, context }) => {
    await page.setViewportSize({ width, height: 900 });
    // The page of the phone audit's world (its stand-ins answer), opened the way that audit opens it: the same text at three widths.
    await open(page, context, VISITS.find((v) => v.slug === 'page')!);

    const report: Record<string, Measured> = {};
    for (const size of TEXT_SIZES) {
      await setTextSize(page, size);
      report[String(size)] = await measure(page);
    }
    // A dialog is open for its own measurement: its buttons are what the overlap check looks at, and a dialog with none open would pass it with nothing to check.
    // A confirmation from the contents (a member is offered no admin reset): its two buttons are what the overlap check has to look at.
    if (width < 641) await page.getByRole('button', { name: 'Show contents', exact: true }).click();
    await page.getByRole('button', { name: 'Actions for Quarterly plan' }).click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    for (const size of TEXT_SIZES) {
      await setTextSize(page, size);
      report[`dialog-${String(size)}`] = await measure(page);
    }
    for (const size of TEXT_SIZES) {
      for (const key of [String(size), `dialog-${String(size)}`]) {
        expect(report[key]!.overflow, `no sideways scroll at ${String(size)}% text, ${String(width)}px wide${key.startsWith('dialog') ? ', a dialog open' : ''}`).toBe(0);
        expect(report[key]!.overlapping, `no overlapping controls at ${String(size)}% text, ${String(width)}px wide${key.startsWith('dialog') ? ', a dialog open' : ''}`).toEqual([]);
      }
    }
    // The two promises this file owns, at the size it exists for: what was measured is also what fails when a control is cut.
    expect(report['200']!.clipped, `no clipped control at 200% text, ${String(width)}px wide`).toEqual([]);
    expect(report['dialog-200']!.clipped, `no clipped control in a dialog at 200% text, ${String(width)}px wide`).toEqual([]);
  });
}
