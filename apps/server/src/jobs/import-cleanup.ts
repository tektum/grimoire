import type { ImportRepo } from '@tektum/grimoire-core/ports/import-repo';
import type { ImportPayload } from './types.js';

export interface ImportCleanupDeps {
  readonly imports: ImportRepo;
  readonly deleteFiles: (keys: readonly string[]) => Promise<void>;
  /** Whether the zip is still in the store; false only when it is gone (any other failure of the store is thrown). */
  readonly zipPresent: (key: string) => Promise<boolean>;
}

/**
 * The `import-cleanup` job: for an import that is over, deletes its zip, and for a `cancelled` or `failed` one first moves the pages it created to the trash as one batch (M7 contracts section
 * stages 6 and 7), so that running it again does not leave duplicates. The zip is the record that this was done: the pages are moved while it is still there and it is deleted after, so a second
 * cleanup (the route's and the job's own, or the daily one) finds it gone and moves nothing, and does not send back to the trash pages that a person restored since. Deleting a key that is gone is not an
 * error. What is left: when the delete of the zip fails after the pages were moved, the retry (30 s later at the earliest) moves them again, and a page restored in that time goes back. `undefined` when
 * there is nothing to do (no such import of the tenant, or not over yet).
 */
export async function runImportCleanup(deps: ImportCleanupDeps, payload: ImportPayload): Promise<{ pages: number; zip: boolean } | undefined> {
  const record = await deps.imports.get(payload.tenantId, payload.importId);
  if (record === undefined || (record.status !== 'done' && record.status !== 'failed' && record.status !== 'cancelled')) return undefined;
  const pending = record.status !== 'done' && (record.s3Key === null || (await deps.zipPresent(record.s3Key)));
  const moved = pending ? await deps.imports.trashImported(payload.tenantId, payload.importId) : undefined;
  if (record.s3Key !== null) await deps.deleteFiles([record.s3Key]);
  return { pages: moved?.pages ?? 0, zip: record.s3Key !== null };
}
