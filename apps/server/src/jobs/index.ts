import type { Clock } from '@tektum/grimoire-core/ports/clock';
import type { AttachmentRepo } from '@tektum/grimoire-core/ports/attachment-repo';
import type { PageStore } from '@tektum/grimoire-core/ports/collaboration-host';
import type { Config } from '@tektum/grimoire-core/ports/config';
import type { Embedder } from '@tektum/grimoire-core/ports/embedder';
import type { EmbeddingStore } from '@tektum/grimoire-core/ports/embedding-store';
import { FileStorageError, type FileStorage } from '@tektum/grimoire-core/ports/file-storage';
import type { ImportRepo } from '@tektum/grimoire-core/ports/import-repo';
import type { JobHandler } from '@tektum/grimoire-core/ports/job-queue';
import type { MarkdownConverter } from '@tektum/grimoire-core/ports/markdown-converter';
import type { RevisionRepo } from '@tektum/grimoire-core/ports/revision-repo';
import type { TenantRepo } from '@tektum/grimoire-core/ports/tenant-repo';
import type { TrashRepo } from '@tektum/grimoire-core/ports/trash-repo';
import { sniffType } from '../attachments/deps.js';
import type { EventLog } from '../events.js';
import type { RemoteImageFetcher } from '../import/remote-images/index.js';
import { createOrdering } from '../tree/position.js';
import { createEmbedPage, embedBatchSize } from './embed-page.js';
import { createEmbedSweep } from './embed-sweep.js';
import { createImportHandler, handleImport } from './import.js';
import { abandonStaleImportsOfAll } from './import-abandon.js';
import { runFailedSourceCleanup } from './failed-sources.js';
import { reconcileEndedImports } from './import-reconcile.js';
import { runImportCleanup } from './import-cleanup.js';
import { runImportSweep } from './import-sweep.js';
import { createMarkdownSweep } from './markdown-sweep.js';
import { runPurge } from './purge.js';
import { createRateLimiter, sleepUnlessAborted } from './rate-limit.js';
import { runRevisionCatchUp } from './revision-catchup.js';
import type { JobsApi } from './runner.js';
import { isImportPayload, type ImportPayload } from './types.js';
import { runUploadCleanup } from './upload-cleanup.js';

export interface RegisteredJob {
  readonly name: string;
  readonly handler: JobHandler;
  /** UTC cron, five fields; absent for a job that is only enqueued. */
  readonly schedule?: string;
  /** A chain finer than a cron (the embed sweep, amendment 16a): each run sends the next one itself, and the runner sends the first run this many seconds after every start. */
  readonly chainSeconds?: number;
}

export interface JobDeps {
  readonly config: Config;
  readonly log: EventLog;
  readonly clock: Clock;
  readonly tenants: TenantRepo;
  readonly trash: TrashRepo;
  readonly deleteFiles: (keys: readonly string[]) => Promise<void>;
  readonly attachments: AttachmentRepo;
  /** Absent when no file store is configured: there are no uploads to clean up. */
  readonly files?: FileStorage;
  readonly revisions: RevisionRepo;
  readonly pages: PageStore;
  readonly converter: MarkdownConverter;
  /** Absent when the semantic search is off or the role has none: the two embedding jobs are then not registered. */
  readonly embedder?: Embedder;
  readonly embeddings?: EmbeddingStore;
  readonly imports: ImportRepo;
  /** The queue, for the jobs that ask about or add another job (the import, its sweep and the cleanups). */
  readonly queue: JobsApi;
  /** Copies pictures from the web into an import; absent when that is switched off (`GRIMOIRE_IMPORT_FETCH_REMOTE_IMAGES`). */
  readonly fetcher?: RemoteImageFetcher;
}

/** The stale-Markdown sweep runs every minute (the finest a cron can say). */
const MARKDOWN_SWEEP_CRON = '* * * * *';

/** The import job: what a runner registers when it is given nothing else (the sweep and the cleanup need the repositories and the queue: `registerJobs`). */
export function importJobs(): readonly RegisteredJob[] {
  return [{ name: 'import', handler: handleImport }];
}

/** The jobs of roles `api` and `all`, by queue name. Cron jobs carry no payload: they walk the tenants themselves. Schedules are carried here and registered by the runner at start (decision 16). */
export function registerJobs(deps: JobDeps): readonly RegisteredJob[] {
  const { config, log, clock } = deps;
  const onSwept = (importId: string, action: string): void => { log.info('import.swept', { importId, action }); };
  const enqueueCleanup = (payload: ImportPayload): Promise<unknown> => deps.queue.enqueueImportCleanup(payload);
  // Without a file store no import has a zip to find, and nothing was moved to hold back.
  const zipPresent = async (key: string): Promise<boolean> => {
    if (deps.files === undefined) return true;
    try {
      await deps.files.head(key);
      return true;
    } catch (e) {
      if (e instanceof FileStorageError && e.kind === 'not-found') return false;
      throw e;
    }
  };
  // Without a file store there is no multipart upload to end.
  const abortUpload = async (key: string, uploadId: string): Promise<void> => {
    await deps.files?.abortMultipart(key, uploadId);
  };
  const sweep = createMarkdownSweep({ pages: deps.pages, converter: deps.converter, now: () => clock.now(), onConvertFailure: (pageId, reason) => log.warn('markdown_sweep.convert_failed', { pageId, reason }) });
  return [
    // The import job (M7-T04) reads its zip from the file store: without one no import can be created, and the stub refuses a stray job rather than dropping it.
    ...(deps.files === undefined ? importJobs() : [{ name: 'import', handler: createImportHandler({
      config, log, clock, imports: deps.imports, files: deps.files, converter: deps.converter, ordering: createOrdering(), fetcher: deps.fetcher, sniff: sniffType, queue: deps.queue,
    }) }]),
    {
      name: 'import-sweep',
      schedule: config.jobs.sweepCron,
      handler: async (_payload, ctx) => {
        await runImportSweep({ tenants: deps.tenants, imports: deps.imports, now: () => clock.now(), isLive: (key) => deps.queue.isLive('import', key), enqueueImport: (payload, key) => deps.queue.enqueueImport(payload, { singletonKey: key }), enqueueCleanup, onSwept }, ctx.signal);
      },
    },
    {
      name: 'import-cleanup',
      // The daily run (no payload) deletes the kept originals of failed pages after 30 days; a run with a payload cleans up one import. Without a file store there is nothing kept.
      schedule: config.jobs.purgeCron,
      handler: async (payload, ctx) => {
        if (payload === undefined || payload === null) {
          if (deps.files === undefined) return;
          // Both passes run whichever fails: a store that cannot list the kept originals must not also skip the safety net, and the run still fails after, to be tried again.
          const sources = await runFailedSourceCleanup({ tenants: deps.tenants, files: deps.files, now: () => clock.now() }, ctx.signal).then(
            (count) => ({ count }),
            (error: unknown) => ({ error }),
          );
          if ('count' in sources) log.info('import.sources_cleaned', { count: sources.count });
          // The safety net: a cleanup that was never enqueued or never ran is made up for here.
          log.info('import.reconciled', await reconcileEndedImports({ tenants: deps.tenants, imports: deps.imports, deleteFiles: deps.deleteFiles, abortUpload, zipPresent, now: () => clock.now() }, ctx.signal));
          if ('error' in sources) throw sources.error;
          return;
        }
        if (!isImportPayload(payload)) return; // an id of the wrong shape names no import
        const done = await runImportCleanup({ imports: deps.imports, deleteFiles: deps.deleteFiles, abortUpload, zipPresent }, payload);
        if (done !== undefined) log.info('import.cleaned', { importId: payload.importId, pages: done.pages, zip: done.zip });
      },
    },
    {
      name: 'purge',
      schedule: config.jobs.purgeCron,
      handler: async (_payload, ctx) => {
        const done = await runPurge({ tenants: deps.tenants, trash: deps.trash, deleteFiles: deps.deleteFiles, now: () => clock.now() }, ctx.signal);
        log.info('purge.completed', done);
      },
    },
    ...(deps.files === undefined ? [] : [{
      name: 'upload-cleanup',
      schedule: config.jobs.uploadCleanupCron,
      handler: async (_payload: unknown, ctx: { readonly signal: AbortSignal }) => {
        const count = await runUploadCleanup({ tenants: deps.tenants, attachments: deps.attachments, files: deps.files as FileStorage, now: () => clock.now() }, ctx.signal);
        log.info('attachments.cleaned', { count });
        await abandonStaleImportsOfAll({ tenants: deps.tenants, imports: deps.imports, now: () => clock.now(), enqueueCleanup, onSwept }, ctx.signal);
      },
    }]),
    { name: 'revision-catchup', schedule: config.jobs.revisionCron, handler: async (_payload, ctx) => { await runRevisionCatchUp({ revisions: deps.revisions, now: () => clock.now() }, ctx.signal); } },
    { name: 'markdown-sweep', schedule: MARKDOWN_SWEEP_CRON, handler: async (_payload, ctx) => { await sweep(ctx.signal); } },
    ...(deps.embedder === undefined || deps.embeddings === undefined ? [] : [
      {
        name: 'embed-sweep',
        chainSeconds: config.semantic.sweepSeconds,
        handler: createEmbedSweep({ tenants: deps.tenants, store: deps.embeddings, embedder: deps.embedder, queue: deps.queue, log, sweepSeconds: config.semantic.sweepSeconds, debounceSeconds: config.semantic.debounceSeconds }),
      },
      { name: 'embed-page', handler: createEmbedPage({ embedder: deps.embedder, store: deps.embeddings, log, clock, limiter: createRateLimiter({ perMinute: config.semantic.maxChunksPerMinute, now: Date.now, sleep: sleepUnlessAborted }), batchSize: embedBatchSize(config.semantic.maxChunksPerMinute) }) }, // real time: the cap and its wait must use the same clock, whatever clock the run log was given
    ]),
  ];
}
