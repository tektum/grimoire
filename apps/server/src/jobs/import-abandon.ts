import type { ImportRepo } from '@tektum/grimoire-core/ports/import-repo';
import type { TenantRepo } from '@tektum/grimoire-core/ports/tenant-repo';
import { forEachTenant } from './tenants.js';
import type { ImportPayload } from './types.js';

/** An import that stayed `created` or `uploaded` this long was never finished (R9.13 expires its upload the same day). */
export const IMPORT_ABANDON_MS = 24 * 3_600_000;

export interface AbandonDeps {
  readonly imports: ImportRepo;
  readonly enqueueCleanup: (payload: ImportPayload) => Promise<unknown>;
  readonly now: () => number;
  /** Told of each import the sweep acted on (the `import.swept` event). */
  readonly onSwept?: (importId: string, action: 'requeued' | 'abandoned') => void;
  /** Rows taken from the repository at a time. */
  readonly batch?: number;
}

/**
 * Fails the tenant's unfinished uploads older than a day (`abandoned`) and enqueues the cleanup that deletes their zip. A row that another run failed meanwhile is not counted and has its
 * cleanup from that run. Returns how many it failed.
 */
export async function abandonStaleImports(deps: AbandonDeps, tenantId: string, signal: AbortSignal): Promise<number> {
  const batch = deps.batch ?? 100;
  let failed = 0;
  while (!signal.aborted) {
    const ids = await deps.imports.stale(tenantId, deps.now() - IMPORT_ABANDON_MS, batch);
    if (ids.length === 0) break;
    let progress = false;
    for (const importId of ids) {
      if (!(await deps.imports.abandon(tenantId, importId, deps.now()))) continue;
      progress = true;
      failed += 1;
      deps.onSwept?.(importId, 'abandoned');
      await deps.enqueueCleanup({ tenantId, importId });
    }
    if (!progress) break; // every row of the round was taken by someone else: they are out of the list now, so a new round would be empty or the same
  }
  return failed;
}

/** `abandonStaleImports` for every tenant (the imports half of the upload cleanup). Returns how many it failed. */
export async function abandonStaleImportsOfAll(deps: AbandonDeps & { readonly tenants: TenantRepo }, signal: AbortSignal): Promise<number> {
  let failed = 0;
  await forEachTenant(await deps.tenants.ids(), signal, async (tenantId) => {
    failed += await abandonStaleImports(deps, tenantId, signal);
  });
  return failed;
}
