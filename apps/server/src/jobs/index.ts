import type { Clock } from '@tektum/grimoire-core/ports/clock';
import type { AttachmentRepo } from '@tektum/grimoire-core/ports/attachment-repo';
import type { PageStore } from '@tektum/grimoire-core/ports/collaboration-host';
import type { Config } from '@tektum/grimoire-core/ports/config';
import type { FileStorage } from '@tektum/grimoire-core/ports/file-storage';
import type { JobHandler } from '@tektum/grimoire-core/ports/job-queue';
import type { MarkdownConverter } from '@tektum/grimoire-core/ports/markdown-converter';
import type { RevisionRepo } from '@tektum/grimoire-core/ports/revision-repo';
import type { TenantRepo } from '@tektum/grimoire-core/ports/tenant-repo';
import type { TrashRepo } from '@tektum/grimoire-core/ports/trash-repo';
import type { EventLog } from '../events.js';
import { handleImport } from './import.js';
import { handleImportCleanup } from './import-cleanup.js';
import { handleImportSweep } from './import-sweep.js';
import { createMarkdownSweep } from './markdown-sweep.js';
import { runPurge } from './purge.js';
import { runRevisionCatchUp } from './revision-catchup.js';
import { runUploadCleanup } from './upload-cleanup.js';

export interface RegisteredJob {
  readonly name: string;
  readonly handler: JobHandler;
  /** UTC cron, five fields; absent for a job that is only enqueued. */
  readonly schedule?: string;
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
}

/** The stale-Markdown sweep runs every minute (the finest a cron can say). */
const MARKDOWN_SWEEP_CRON = '* * * * *';

/** The import jobs: what a runner registers when it is given nothing else. */
export function importJobs(config: Config): readonly RegisteredJob[] {
  return [
    { name: 'import', handler: handleImport },
    { name: 'import-sweep', handler: handleImportSweep, schedule: config.jobs.sweepCron },
    { name: 'import-cleanup', handler: handleImportCleanup },
  ];
}

/** The jobs of roles `api` and `all`, by queue name. Cron jobs carry no payload: they walk the tenants themselves. Schedules are carried here and registered by the runner once the soak allows it (decision 13). */
export function registerJobs(deps: JobDeps): readonly RegisteredJob[] {
  const { config, log, clock } = deps;
  const sweep = createMarkdownSweep({ pages: deps.pages, converter: deps.converter, now: () => clock.now(), onConvertFailure: (pageId, reason) => log.warn('markdown_sweep.convert_failed', { pageId, reason }) });
  return [
    ...importJobs(config),
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
      },
    }]),
    { name: 'revision-catchup', schedule: config.jobs.revisionCron, handler: async (_payload, ctx) => { await runRevisionCatchUp({ revisions: deps.revisions, now: () => clock.now() }, ctx.signal); } },
    { name: 'markdown-sweep', schedule: MARKDOWN_SWEEP_CRON, handler: async (_payload, ctx) => { await sweep(ctx.signal); } },
  ];
}
