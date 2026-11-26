import type { ImportRepo } from '@tektum/grimoire-core/ports/import-repo';
import type { TenantRepo } from '@tektum/grimoire-core/ports/tenant-repo';
import { runImportCleanup, type ImportCleanupDeps } from './import-cleanup.js';
import { forEachTenant } from './tenants.js';

const DAY = 86_400_000;
/** An import gets a day to have its own cleanup run before the daily pass does it. */
const GRACE_MS = DAY;
/** How far back the pass looks: a cleanup that was missed is made up for within this time. */
const LOOKBACK_MS = 14 * DAY;

export interface ReconcileDeps extends ImportCleanupDeps {
  readonly tenants: TenantRepo;
  readonly imports: ImportRepo;
  readonly now: () => number;
  readonly batch?: number;
}

/**
 * The daily safety net of `import-cleanup`: for every import that ended between a day and a fortnight ago, runs its cleanup again (pages of a `cancelled` or `failed` one to the trash, the zip deleted;
 * both idempotent), so a cleanup that was never enqueued (the queue was down) or never ran costs at most a day. Returns how many zips it asked to delete and how many pages it moved.
 */
export async function reconcileEndedImports(deps: ReconcileDeps, signal: AbortSignal): Promise<{ zips: number; pages: number }> {
  const now = deps.now();
  const until = now - GRACE_MS;
  let zips = 0;
  let pages = 0;
  await forEachTenant(await deps.tenants.ids(), signal, async (tenantId) => {
    for (let afterId: string | undefined; !signal.aborted; ) {
      const batch = await deps.imports.ended(tenantId, { since: now - LOOKBACK_MS, ...(afterId === undefined ? {} : { afterId }), limit: deps.batch ?? 100 });
      if (batch.length === 0) break;
      for (const record of batch) {
        if ((record.finishedAt ?? 0) > until) continue;
        const done = await runImportCleanup(deps, { tenantId, importId: record.id });
        if (done?.zip === true) zips += 1;
        pages += done?.pages ?? 0;
      }
      afterId = batch[batch.length - 1]?.id;
    }
  });
  return { zips, pages };
}
