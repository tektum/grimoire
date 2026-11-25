import type { RevisionRepo } from '@tektum/grimoire-core/ports/revision-repo';

/** A page counts as idle when its last edit is this old: the same five minutes the first-open query uses. */
export const CATCH_UP_IDLE_MS = 5 * 60_000;

export interface RevisionCatchUpDeps {
  readonly revisions: RevisionRepo;
  readonly now: () => number;
  readonly batchSize?: number;
}

/**
 * The daily revision catch-up (R9.3, R2.24): `RevisionRepo.catchUp` in batches until one makes no revision. The repository makes the revision of each page in
 * the page's own tenant, under the page's lock, so the job and a concurrent first-open query on one page yield one revision. Returns how many it made.
 */
export async function runRevisionCatchUp(deps: RevisionCatchUpDeps, signal: AbortSignal): Promise<number> {
  const size = deps.batchSize ?? 500;
  let total = 0;
  for (;;) {
    const made = await deps.revisions.catchUp(deps.now() - CATCH_UP_IDLE_MS, size);
    total += made.length;
    // A short batch proves nothing: `catchUp` re-checks each candidate under its page lock and skips one that a concurrent save or first-open query already covered. Only an empty one does.
    if (made.length === 0 || signal.aborted) return total;
  }
}
