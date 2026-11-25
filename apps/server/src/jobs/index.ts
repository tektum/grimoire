import type { Config } from '@tektum/grimoire-core/ports/config';
import type { JobHandler } from '@tektum/grimoire-core/ports/job-queue';
import { handleImport } from './import.js';
import { handleImportCleanup } from './import-cleanup.js';
import { handleImportSweep } from './import-sweep.js';

export interface RegisteredJob {
  readonly name: string;
  readonly handler: JobHandler;
  /** UTC cron, five fields; absent for a job that is only enqueued. */
  readonly schedule?: string;
}

export interface JobDeps { readonly config: Config }

/** The jobs of this milestone, by queue name. Later tasks add their own (purge, upload cleanup, revision catch-up) and fill the handlers. */
export function registerJobs(deps: JobDeps): readonly RegisteredJob[] {
  return [
    { name: 'import', handler: handleImport },
    { name: 'import-sweep', handler: handleImportSweep, schedule: deps.config.jobs.sweepCron },
    { name: 'import-cleanup', handler: handleImportCleanup },
  ];
}
