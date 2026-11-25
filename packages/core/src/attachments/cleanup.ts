import type { AttachmentRepo } from '../ports/attachment-repo.js';
import type { FileStorage } from '../ports/file-storage.js';

/**
 * Removes up to `batch` pending uploads of the tenant that expired before `now`: the object first, then the row, and only a row that is still pending (an upload that completed
 * in the meantime keeps both). Safe to run twice and to run while uploads complete: a missing object is a success, and an expired upload cannot become ready. Returns
 * how many rows it removed. A store that is down throws, and the rows stay for the next run.
 */
export async function cleanupExpiredAttachments(o: { readonly repo: AttachmentRepo; readonly files: FileStorage; readonly tenantId: string; readonly now: () => number; readonly batch: number }): Promise<number> {
  let removed = 0;
  for (const row of await o.repo.expiredPending(o.tenantId, o.now(), o.batch)) {
    await o.files.delete(row.key);
    if (await o.repo.removeIfPending(row.id)) removed += 1;
  }
  return removed;
}
