import type { ImportRepo } from '@tektum/grimoire-core/ports/import-repo';
import type { TenantRepo } from '@tektum/grimoire-core/ports/tenant-repo';
import { abandonStaleImports, type AbandonDeps } from './import-abandon.js';
import { forEachTenant } from './tenants.js';
import { importSingletonKey, type ImportPayload } from './types.js';

export interface ImportSweepDeps extends AbandonDeps {
  readonly tenants: TenantRepo;
  readonly imports: ImportRepo;
  /** Whether the queue has a job of the import `import` under this singleton key, queued or running. */
  readonly isLive: (singletonKey: string) => Promise<boolean>;
  readonly enqueueImport: (payload: ImportPayload, singletonKey: string) => Promise<unknown>;
}

/**
 * The `import-sweep` job (R10.16): a `running` import with no live job (a crash between two steps) is enqueued again, and unfinished uploads older than a day are failed (the same step as
 * the upload cleanup, which is idempotent). Tenant by tenant, each with its own repository calls.
 */
export async function runImportSweep(deps: ImportSweepDeps, signal: AbortSignal): Promise<{ requeued: number; abandoned: number }> {
  let requeued = 0;
  let abandoned = 0;
  await forEachTenant(await deps.tenants.ids(), signal, async (tenantId) => {
    for (const importId of await deps.imports.running(tenantId)) {
      const key = importSingletonKey(importId);
      if (await deps.isLive(key)) continue;
      await deps.enqueueImport({ tenantId, importId }, key);
      requeued += 1;
      deps.onSwept?.(importId, 'requeued');
    }
    abandoned += await abandonStaleImports(deps, tenantId, signal);
  });
  return { requeued, abandoned };
}
