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

test.describe.configure({ mode: 'serial' });

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
    for (const size of TEXT_SIZES) {
      expect(report[String(size)]!.overflow, `no sideways scroll at ${String(size)}% text, ${String(width)}px wide`).toBe(0);
      expect(report[String(size)]!.overlapping, `no overlapping controls at ${String(size)}% text, ${String(width)}px wide`).toEqual([]);
    }
    // The two promises this file owns, at the size it exists for: what was measured is also what fails when a control is cut.
    expect(report['200']!.clipped, `no clipped control at 200% text, ${String(width)}px wide`).toEqual([]);
  });
}
