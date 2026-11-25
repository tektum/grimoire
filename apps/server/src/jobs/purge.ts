import { purgeBatch } from '@tektum/grimoire-core/pages/purge';
import type { TenantRepo } from '@tektum/grimoire-core/ports/tenant-repo';
import type { TrashRepo } from '@tektum/grimoire-core/ports/trash-repo';
import { forEachTenant } from './tenants.js';

/** How long the trash keeps a batch (R9.20): a constant, not a setting. */
export const TRASH_RETENTION_MS = 30 * 86_400_000;
/** The system user, which is who the audit row of a purge by the job names. */
const SYSTEM_ACTOR = '00000000-0000-4000-8000-000000000001';

export interface PurgeJobDeps {
  readonly tenants: TenantRepo;
  readonly trash: TrashRepo;
  readonly deleteFiles: (keys: readonly string[]) => Promise<void>;
  readonly now: () => number;
  readonly batchSize?: number;
}

/**
 * The daily purge: in each tenant, every batch deleted more than 30 days ago, objects first and then the rows (`purgeBatch`). A run can be repeated:
 * a batch already gone is not listed, and an object already absent is a success. A batch that fails does not stop the others of its tenant: it is
 * passed over for the rest of the run and the first failure is thrown at the end, so the job is retried. Returns what it removed, for `purge.completed`.
 */
export async function runPurge(deps: PurgeJobDeps, signal: AbortSignal): Promise<{ readonly pages: number; readonly objects: number }> {
  const size = deps.batchSize ?? 50;
  let pages = 0;
  let objects = 0;
  await forEachTenant(await deps.tenants.ids(), signal, async (tenantId) => {
    const handled = new Set<string>(); // listed oldest first, so a batch that failed or was already gone would come back first: ask for room beyond them
    let failure: { readonly error: unknown } | undefined;
    for (;;) {
      const fresh = (await deps.trash.expiredBatches(tenantId, deps.now() - TRASH_RETENTION_MS, size + handled.size)).filter((b) => !handled.has(b));
      for (const batch of fresh.slice(0, size)) {
        if (signal.aborted) break;
        handled.add(batch);
        try {
          const done = await purgeBatch(deps, tenantId, batch, SYSTEM_ACTOR);
          pages += done.pages;
          if (done.pages > 0) objects += done.files; // a batch another purge removed first is not this run's objects
        } catch (error) {
          failure ??= { error };
        }
      }
      if (fresh.length < size || signal.aborted) break;
    }
    if (failure) throw failure.error;
  });
  return { pages, objects };
}
