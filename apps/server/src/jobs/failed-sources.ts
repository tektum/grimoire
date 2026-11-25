import type { FileStorage } from '@tektum/grimoire-core/ports/file-storage';
import type { TenantRepo } from '@tektum/grimoire-core/ports/tenant-repo';
import { forEachTenant } from './tenants.js';

/** How long the kept original of a failed page can be downloaded (M7 contracts section 3). */
export const FAILED_SOURCE_RETENTION_MS = 30 * 86_400_000;

export interface FailedSourceDeps {
  readonly tenants: TenantRepo;
  readonly files: FileStorage;
  readonly now: () => number;
  /** Keys asked of the store at a time. */
  readonly pageSize?: number;
}

/** `tenants/<tenant>/imports/<import>/failed/<item>.md`: the layout of `importFailedKey`. */
const FAILED = /^tenants\/[^/]+\/imports\/[^/]+\/failed\/[^/]+\.md$/;

/**
 * Deletes the kept originals of failed pages that were written more than 30 days ago, tenant by tenant (the daily run of `import-cleanup`). The age is the object's own, not the import's finish: an
 * import takes hours, so the two differ by that, and it needs no row to say which imports were looked at already. Returns how many it deleted.
 */
export async function runFailedSourceCleanup(deps: FailedSourceDeps, signal: AbortSignal): Promise<number> {
  const before = deps.now() - FAILED_SOURCE_RETENTION_MS;
  let deleted = 0;
  await forEachTenant(await deps.tenants.ids(), signal, async (tenantId) => {
    for (let cursor: string | undefined; !signal.aborted; ) {
      const page = await deps.files.list(`tenants/${tenantId}/imports/`, { ...(cursor === undefined ? {} : { cursor }), limit: deps.pageSize ?? 500 });
      for (const item of page.items) {
        if (!FAILED.test(item.key) || item.modifiedAt >= before) continue;
        await deps.files.delete(item.key);
        deleted += 1;
      }
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
  });
  return deleted;
}
