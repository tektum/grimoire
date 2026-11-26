import type { ImportRepo } from '@tektum/grimoire-core/ports/import-repo';
import type { ImportPayload } from './types.js';

export interface ImportCleanupDeps {
  readonly imports: ImportRepo;
  readonly deleteFiles: (keys: readonly string[]) => Promise<void>;
  /** Ends a multipart upload that was never completed (the store drops its parts; one it does not know is a success). */
  readonly abortUpload: (key: string, uploadId: string) => Promise<void>;
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
  // Every zip goes: the keys of the parts (the first is the import's own `s3Key`), after the multipart uploads that were never completed are ended, so that no part is left billed in the store.
  const parts = await deps.imports.parts(payload.tenantId, payload.importId);
  for (const part of parts) if (part.uploadId !== null) await deps.abortUpload(part.s3Key, part.uploadId);
  const keys = [...new Set([...(record.s3Key === null ? [] : [record.s3Key]), ...parts.map((part) => part.s3Key)])];
  if (keys.length > 0) await deps.deleteFiles(keys);
  return { pages: moved?.pages ?? 0, zip: keys.length > 0 };
}
