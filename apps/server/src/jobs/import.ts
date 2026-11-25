import { FileStorageError } from '@tektum/grimoire-core/ports/file-storage';
import type { Clock } from '@tektum/grimoire-core/ports/clock';
import type { Config } from '@tektum/grimoire-core/ports/config';
import type { FileStorage } from '@tektum/grimoire-core/ports/file-storage';
import { NO_IMPORT_COUNTS } from '@tektum/grimoire-core/ports/import-repo';
import type { ImportRepo } from '@tektum/grimoire-core/ports/import-repo';
import type { EnqueueOptions, JobHandler } from '@tektum/grimoire-core/ports/job-queue';
import type { MarkdownConverter } from '@tektum/grimoire-core/ports/markdown-converter';
import type { Ordering } from '@tektum/grimoire-core/tree/position';
import type { EventLog } from '../events.js';
import { passOne, passTwo } from '../import/engine.js';
import { importZipKey } from '../import/keys.js';
import { markdownProfile } from '../import/markdown-profile.js';
import type { RemoteImageFetcher } from '../import/remote-images/index.js';
import { openArchive } from '../import/zip-reader.js';
import { isImportPayload, notImplemented } from './types.js';

export interface ImportJobDeps {
  readonly config: Config;
  readonly log: EventLog;
  readonly clock: Clock;
  readonly imports: ImportRepo;
  readonly files: FileStorage;
  readonly converter: MarkdownConverter;
  readonly ordering: Pick<Ordering, 'between'>;
  /** Absent when fetching remote images is switched off. */
  readonly fetcher: RemoteImageFetcher | undefined;
  /** The media type the first bytes of a file show. */
  readonly sniff: (bytes: Uint8Array) => Promise<string | undefined>;
  /** The two jobs a running import hands on: its own continuation and its clean-up (the runner's `JobsApi`). */
  readonly queue: {
    enqueueImport(payload: { readonly importId: string; readonly tenantId: string }, options?: EnqueueOptions): Promise<string | null>;
    enqueueImportCleanup(payload: { readonly importId: string; readonly tenantId: string }): Promise<string | null>;
  };
  /** How long one run of the job works before it hands the rest to its continuation (default 300 s). */
  readonly chunkMs?: number;
  readonly batchPages?: number;
  /** The most pages a collection holds (default 10,000; a test names a smaller one). */
  readonly maxPages?: number;
}

const DEFAULT_CHUNK_MS = 300_000;
/** How long a continuation waits when the converter is busy. */
const BUSY_DELAY_SECONDS = 30;

/**
 * The `import` job (M7 contracts section 4). `start` moves the import from `uploaded` to `running`; for an import that is not waiting or running (cancelled, done, failed, not found) it
 * answers nothing and the job returns without doing anything, and for a tenant that already has a running import it rejects with `ImportBusyError`, which goes up so the queue tries
 * again later. Then: stage 2 (the archive, read through ranged gets of the store), pass one, and pass two in chunks. A chunk that has used its time, a job near its expiry, and a busy
 * converter all end the same way: the import stays `running` and the handler enqueues its own continuation under the import's key (the queue is `stately`: one queued and one
 * running job per key) and returns. The import ends as `done` when every page is dealt with (also when some items failed or were skipped), or `failed` with a code in `error`: an
 * archive that was refused, a collection that is gone, or the job's own failure on its last attempt. Every ending asks for the clean-up (`import-cleanup`), which is idempotent;
 * a cancelled import is the canceller's to clean up.
 */
export function createImportHandler(deps: ImportJobDeps): JobHandler {
  const { config, log, imports, files } = deps;
  const now = (): number => deps.clock.now();

  return async (payload, ctx) => {
    if (!isImportPayload(payload)) { log.warn('import.failed', { importId: 'unknown', reason: 'bad_payload' }); return; }
    const { tenantId, importId } = payload;
    const record = await imports.start(tenantId, importId, now()); // an `ImportBusyError` goes up: the queue retries later
    if (record === undefined) {
      // An end that was recorded but whose clean-up ask was lost (the enqueue failed, the job was retried) is asked for again: the clean-up is idempotent.
      const ended = await imports.get(tenantId, importId);
      if (ended?.status === 'done' || ended?.status === 'failed') await deps.queue.enqueueImportCleanup({ importId, tenantId });
      return;
    }
    log.info('import.started', { importId });

    const key = `import:${importId}`;
    const fail = async (code: string): Promise<void> => {
      if (await imports.finish(tenantId, importId, 'failed', code, now())) {
        log.warn('import.failed', { importId, reason: code });
        await deps.queue.enqueueImportCleanup({ importId, tenantId });
      }
    };
    const continueLater = (delaySeconds?: number): Promise<string | null> => deps.queue.enqueueImport({ importId, tenantId }, { singletonKey: key, ...(delaySeconds === undefined ? {} : { delaySeconds }) });

    try {
      const zipKey = record.s3Key ?? importZipKey(tenantId, importId);
      let size: number;
      try { size = (await files.head(zipKey)).size; } catch (e) {
        if (e instanceof FileStorageError && e.kind === 'not-found') { await fail('upload_missing'); return; }
        throw e;
      }
      const opened = await openArchive(files, zipKey, size, config.import);
      if (opened.kind === 'refused') {
        log.warn('import.archive_refused', { importId, reason: opened.reason });
        await fail(opened.reason);
        return;
      }
      try {
        const one = await passOne(imports, tenantId, importId, opened.entries, { profile: markdownProfile, allowNestedZips: config.import.allowNestedZips, maxPages: deps.maxPages ?? 10_000 });
        if (!one.ok) {
          await imports.setCounts(tenantId, importId, { ...NO_IMPORT_COUNTS, pagesTotal: one.pagesTotal });
          await fail(one.reason);
          return;
        }
        const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(deps.chunkMs ?? DEFAULT_CHUNK_MS)]);
        const current = (await imports.get(tenantId, importId)) ?? record;
        const result = await passTwo({
          repo: imports, files, converter: deps.converter, profile: markdownProfile, ordering: deps.ordering, reader: opened.reader, entries: opened.entries,
          limits: { maxEntryBytes: config.import.maxEntryBytes, maxRatio: config.import.maxRatio, seedMaxMarkdownBytes: config.collab.seedMaxMarkdownBytes, maxStateBytes: config.collab.maxStateBytes },
          pageLimits: { maxDepth: 32, maxPages: deps.maxPages ?? 10_000, maxTenantPages: config.tenantLimits.maxPages }, now,
          ...(config.files === undefined ? {} : { attachments: { maxBytes: config.files.maxBytes, allowedTypes: config.files.allowedTypes, sniff: deps.sniff } }),
          remote: { fetcher: deps.fetcher, config: config.import.remote },
        }, current, { signal, ...(deps.batchPages === undefined ? {} : { batchPages: deps.batchPages }) });
        log.info('import.progress', { importId, pagesDone: result.counts.pagesDone, pagesTotal: result.counts.pagesTotal });
        if (result.kind === 'done') {
          if (await imports.finish(tenantId, importId, 'done', null, now())) {
            log.info('import.finished', { importId, ok: result.counts.pagesDone, skipped: result.counts.skipped, failed: result.counts.failed });
            await deps.queue.enqueueImportCleanup({ importId, tenantId });
          }
        } else if (result.kind === 'busy') {
          await continueLater(BUSY_DELAY_SECONDS);
        } else if (result.reason === 'aborted') {
          await continueLater();
        } else if (result.reason === 'collection_deleted') {
          await fail('collection_deleted');
        } // `not_running`: cancelled (or ended) by someone else; whoever did it asks for the clean-up
      } finally {
        opened.reader.close();
      }
    } catch (e) {
      // The queue retries while retries remain; on the last attempt the import ends failed, and the error still goes up so the job is marked failed too.
      if (ctx.attempt > ctx.retryLimit) await fail('job_failed');
      throw e;
    }
  };
}

/** The `import` job while its dependencies are not composed. */
export const handleImport = notImplemented('import');
