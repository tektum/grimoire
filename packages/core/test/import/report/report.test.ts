import { describe, expect, it } from 'vitest';
import { buildReport, REPORT_LINES } from '../../../src/import/report.js';
import type { ImportItem } from '../../../src/ports/import-repo.js';

// M7-T04 (contracts section 4, step 5, Q21): the largest pages by Markdown and by state, and every page over the state cap, from the item rows.
const item = (n: number, over: Partial<ImportItem> = {}): ImportItem => ({
  id: String(n), path: `p${String(n)}.md`, kind: 'page', status: 'ok', pageId: null, urlId: null, message: null, markdownBytes: null, stateBytes: null, attempts: 0, warnings: 0, remoteImageFailures: {}, ...over,
});

describe('the Q21 report', () => {
  it('lists the 10 largest by Markdown and the 10 largest by state, each descending, from 25 pages', () => {
    const items = Array.from({ length: 25 }, (_, i) => item(i + 1, { markdownBytes: (i + 1) * 100, stateBytes: (25 - i) * 1000 }));
    const report = buildReport(items);
    expect(REPORT_LINES).toBe(10);
    expect(report.largestByMarkdown.map((l) => l.itemId)).toEqual(['25', '24', '23', '22', '21', '20', '19', '18', '17', '16']);
    expect(report.largestByMarkdown[0]).toEqual({ itemId: '25', path: 'p25.md', markdownBytes: 2500, stateBytes: 1000 });
    expect(report.largestByState.map((l) => l.itemId)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
    expect(report.largestByState.map((l) => l.stateBytes)).toEqual([25000, 24000, 23000, 22000, 21000, 20000, 19000, 18000, 17000, 16000]);
  });

  it('is shorter than 10 when there are fewer pages, and empty with none', () => {
    expect(buildReport([item(1, { markdownBytes: 5, stateBytes: 9 }), item(2, { markdownBytes: 7, stateBytes: 3 })]).largestByMarkdown.map((l) => l.itemId)).toEqual(['2', '1']);
    expect(buildReport([])).toEqual({ largestByMarkdown: [], largestByState: [], overCap: [] });
  });

  it('ties are by path, so the report is the same however the rows come', () => {
    const a = item(1, { path: 'b.md', markdownBytes: 10, stateBytes: 10 });
    const b = item(2, { path: 'a.md', markdownBytes: 10, stateBytes: 10 });
    expect(buildReport([a, b]).largestByMarkdown.map((l) => l.path)).toEqual(['a.md', 'b.md']);
    expect(buildReport([b, a]).largestByMarkdown.map((l) => l.path)).toEqual(['a.md', 'b.md']);
  });

  it('a page with no size recorded (it never got that far) is in neither list; a state size of 0 is a size', () => {
    const report = buildReport([item(1, { markdownBytes: 40 }), item(2, { markdownBytes: 30, stateBytes: 0 })]);
    expect(report.largestByMarkdown.map((l) => l.itemId)).toEqual(['1', '2']);
    expect(report.largestByState.map((l) => l.itemId)).toEqual(['2']);
  });

  it('only pages count, not attachments or files', () => {
    const report = buildReport([item(1, { kind: 'attachment', markdownBytes: 999, stateBytes: 999 }), item(2, { markdownBytes: 1, stateBytes: 1 })]);
    expect(report.largestByMarkdown.map((l) => l.itemId)).toEqual(['2']);
  });

  it('overCap is every page that failed state_too_large, however many, largest state first, and no other failure', () => {
    const over = Array.from({ length: 13 }, (_, i) => item(i + 1, { status: 'failed', message: 'state_too_large', markdownBytes: 1000 + i, stateBytes: 1_536_001 + i }));
    const other = item(99, { status: 'failed', message: 'invalid-markdown', markdownBytes: 5 });
    const okButBig = item(98, { markdownBytes: 50, stateBytes: 1_500_000 });
    const report = buildReport([...over, other, okButBig]);
    expect(report.overCap).toHaveLength(13);
    expect(report.overCap[0]).toEqual({ itemId: '13', path: 'p13.md', markdownBytes: 1012, stateBytes: 1_536_013 });
    expect(report.overCap.map((l) => l.itemId)).not.toContain('99');
    expect(report.largestByState).toHaveLength(10);
    expect(report.largestByState[0]?.itemId).toBe('13');
  });
});
