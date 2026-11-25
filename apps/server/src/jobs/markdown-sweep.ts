import type { PageStore } from '@tektum/grimoire-core/ports/collaboration-host';
import type { MarkdownConverter } from '@tektum/grimoire-core/ports/markdown-converter';

/** A page whose mark is younger than this is left to the host that is probably still saving it: a saving of work only, the write is safe without it. */
export const SWEEP_QUIET_MS = 2 * 60_000;
const PAGES_PER_RUN = 50;
const MAX_BACKOFF_MS = 60 * 60_000;
const REPORT_EVERY_MS = 60 * 60_000;

export interface MarkdownSweepDeps {
  readonly pages: PageStore;
  readonly converter: MarkdownConverter;
  readonly now: () => number;
  /** A page that cannot be converted, at most once an hour for each page. `reason` is the converter's failure code, never page content. */
  readonly onConvertFailure: (pageId: string, reason: string) => void;
}

export interface MarkdownSweepResult { readonly repaired: number; readonly skipped: number; readonly failed: number }

/**
 * The stale-Markdown sweep: re-derives the Markdown of up to 50 pages a run from their stored state. The write is a compare-and-set
 * (`PageStore.repairMarkdown`): a save between the read and the write makes it a skip, retried by the next run, never an overwrite. A page that cannot be
 * converted keeps its mark and is tried again after 1, 2, 4 ... minutes (at most an hour); the backoff lives in this process, which only costs a retry after a restart.
 * Several instances may sweep at once: the compare-and-set lets one write and the rest skip.
 */
export function createMarkdownSweep(deps: MarkdownSweepDeps): (signal: AbortSignal) => Promise<MarkdownSweepResult> {
  const failing = new Map<string, { failures: number; retryAt: number; reportedAt: number }>();
  return async (signal) => {
    let repaired = 0;
    let skipped = 0;
    let failed = 0;
    let attempts = 0;
    // Pages that are backing off sit at the front of the list with their old marks: ask for room beyond them, and forget the ones that left the list (their mark was cleared by a save).
    const listed = await deps.pages.listStale(PAGES_PER_RUN * 4 + failing.size);
    const stale = new Set(listed);
    for (const id of failing.keys()) if (!stale.has(id)) failing.delete(id);
    for (const id of listed) {
      if (signal.aborted || attempts >= PAGES_PER_RUN) break;
      const now = deps.now();
      const backoff = failing.get(id);
      if (backoff !== undefined && now < backoff.retryAt) continue;
      const page = await deps.pages.load(id);
      if (page === undefined || page.state === null || page.markdownStaleSince === null) { failing.delete(id); skipped += 1; continue; }
      if (now - page.markdownStaleSince < SWEEP_QUIET_MS) continue;
      attempts += 1;
      const converted = await deps.converter.toMarkdown(page.state);
      if (!converted.ok) {
        failed += 1;
        const failures = (backoff?.failures ?? 0) + 1;
        const reportedAt = backoff?.reportedAt ?? Number.NEGATIVE_INFINITY;
        const report = now - reportedAt >= REPORT_EVERY_MS;
        if (report) deps.onConvertFailure(id, converted.reason);
        failing.set(id, { failures, retryAt: now + Math.min(60_000 * 2 ** (failures - 1), MAX_BACKOFF_MS), reportedAt: report ? now : reportedAt });
        continue;
      }
      const outcome = await deps.pages.repairMarkdown(id, { state: page.state, epoch: page.epoch }, { markdown: converted.markdown, text: converted.text });
      if (outcome === 'repaired') { failing.delete(id); repaired += 1; } else skipped += 1;
    }
    return { repaired, skipped, failed };
  };
}
