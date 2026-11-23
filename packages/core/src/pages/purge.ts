import type { TrashRepo } from '../ports/trash-repo.js';

export interface PurgeDeps {
  readonly trash: TrashRepo;
  /** Removes the objects of attachments from the file store; rejects when it cannot. */
  readonly deleteFiles: (keys: readonly string[]) => Promise<void>;
}

/**
 * Permanently removes a deleted batch: the attachments' objects first, then every page row in one statement. If the files cannot be
 * removed this throws and no row is touched, so the purge can be run again; running it again for a batch that is gone is a no-op. A restore that lands between the two steps cannot leave a live page with an attachment whose object is gone: the repository marks those attachments deleted. The
 * same function serves the administrator's `DELETE /v1/trash/{id}` and the daily job.
 */
export async function purgeBatch(deps: PurgeDeps, batch: string, actorId: string): Promise<{ readonly pages: number; readonly files: number }> {
  const keys = await deps.trash.attachmentKeys(batch);
  if (keys.length > 0) await deps.deleteFiles(keys);
  const { pages } = await deps.trash.purge(batch, actorId, keys);
  return { pages, files: keys.length };
}
