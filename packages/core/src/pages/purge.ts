import type { TrashRepo } from '../ports/trash-repo.js';

/** What `deleteFiles` rejects with when the store failed after removing some objects: the keys it did remove, and the failure itself as the cause. */
export class PartialFileDeletion extends Error {
  constructor(readonly removed: readonly string[], cause: unknown) {
    super('the file store removed some objects and then failed', { cause });
    this.name = 'PartialFileDeletion';
  }
}

export interface PurgeDeps {
  readonly trash: TrashRepo;
  /** Removes the objects of attachments from the file store; rejects when it cannot (with `PartialFileDeletion` when it had removed some objects first). */
  readonly deleteFiles: (keys: readonly string[]) => Promise<void>;
}

/**
 * Permanently removes a deleted batch: the attachments' objects first, then every page row in one statement. If the files cannot be
 * removed this throws (the store's own failure) and no page row is touched, so the purge can be run again; attachment rows whose objects were removed before the failure are marked deleted; running it again for a batch that is gone is a no-op. A restore that lands between the two steps cannot leave a live page with an attachment whose object is gone: the repository marks those attachments deleted. The
 * same function serves the administrator's `DELETE /v1/trash/{id}` and the daily job.
 */
export async function purgeBatch(deps: PurgeDeps, tenantId: string, batch: string, actorId: string): Promise<{ readonly pages: number; readonly files: number }> {
  const keys = await deps.trash.attachmentKeys(tenantId, batch);
  if (keys.length > 0) {
    try {
      await deps.deleteFiles(keys);
    } catch (error) {
      if (!(error instanceof PartialFileDeletion)) throw error;
      // Objects are gone whose rows stay (the purge did not complete): mark them, so a restore of the batch never shows an attachment without its object.
      // The marker is tried twice; if it still fails, the store's failure is the one reported (a retry of the purge marks the rows of any page a restore brought back).
      for (let attempt = 0; attempt < 2 && error.removed.length > 0; attempt += 1) {
        try {
          await deps.trash.markFilesRemoved(tenantId, error.removed);
          break;
        } catch {
          // try again, then give up
        }
      }
      throw error.cause;
    }
  }
  const { pages } = await deps.trash.purge(tenantId, batch, actorId, keys);
  return { pages, files: keys.length };
}
