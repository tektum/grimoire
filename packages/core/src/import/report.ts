import type { ImportItem } from '../ports/import-repo.js';

/** How many pages each of the two size lists holds (Q21). */
export const REPORT_LINES = 10;

export interface SizeLine {
  readonly itemId: string;
  readonly path: string;
  readonly markdownBytes: number | null;
  readonly stateBytes: number | null;
}

/** The Q21 report (M7 contracts section 4, step 5), built from the item rows: the pages that cost most, and every page the state cap refused. */
export interface ImportReport {
  readonly largestByMarkdown: readonly SizeLine[];
  readonly largestByState: readonly SizeLine[];
  readonly overCap: readonly SizeLine[];
}

const line = (i: ImportItem): SizeLine => ({ itemId: i.id, path: i.path, markdownBytes: i.markdownBytes, stateBytes: i.stateBytes });
const byPath = (a: ImportItem, b: ImportItem): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** Descending by `size`, ties by path (so the report does not depend on the order the rows come in). */
const largest = (items: readonly ImportItem[], size: (i: ImportItem) => number | null, limit: number): SizeLine[] =>
  items.filter((i) => size(i) !== null).sort((a, b) => (size(b) as number) - (size(a) as number) || byPath(a, b)).slice(0, limit).map(line);

export function buildReport(items: readonly ImportItem[]): ImportReport {
  const pages = items.filter((i) => i.kind === 'page');
  return {
    largestByMarkdown: largest(pages, (i) => i.markdownBytes, REPORT_LINES),
    largestByState: largest(pages, (i) => i.stateBytes, REPORT_LINES),
    overCap: largest(pages.filter((i) => i.status === 'failed' && i.message === 'state_too_large'), (i) => i.stateBytes, Number.POSITIVE_INFINITY),
  };
}
