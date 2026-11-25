import { cleanupExpiredAttachments } from '@tektum/grimoire-core/attachments/cleanup';
import type { AttachmentRepo } from '@tektum/grimoire-core/ports/attachment-repo';
import type { FileStorage } from '@tektum/grimoire-core/ports/file-storage';
import type { TenantRepo } from '@tektum/grimoire-core/ports/tenant-repo';
import { forEachTenant } from './tenants.js';

export interface UploadCleanupDeps {
  readonly tenants: TenantRepo;
  readonly attachments: AttachmentRepo;
  readonly files: FileStorage;
  readonly now: () => number;
  readonly batchSize?: number;
}

/** Removes the pending uploads that expired (R9.13), tenant by tenant, a batch at a time. Returns how many it removed. */
export async function runUploadCleanup(deps: UploadCleanupDeps, signal: AbortSignal): Promise<number> {
  const batch = deps.batchSize ?? 500;
  let removed = 0;
  await forEachTenant(await deps.tenants.ids(), signal, async (tenantId) => {
    for (;;) {
      const n = await cleanupExpiredAttachments({ repo: deps.attachments, files: deps.files, tenantId, now: deps.now, batch });
      removed += n;
      if (n === 0 || signal.aborted) return; // a row that completed or went meanwhile makes a round short, so only an empty round ends it
    }
  });
  return removed;
}
