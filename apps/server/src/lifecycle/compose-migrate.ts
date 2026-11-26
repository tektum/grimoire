import { jobQueues } from '@tektum/grimoire-core/jobs/queues';
import { composeMigrate as composeDatabase, migrateAdapter } from '../composition.js';
import type { MigrateOptions, CommandCompositionResult } from '../composition.js';

/** Migration calls receive their adapter bound in composition.ts (S1); cli.ts executes and closes it. */
export function composeMigrate(options: MigrateOptions = {}): CommandCompositionResult & { readonly migrate: (dir: string) => Promise<{ readonly applied: string[]; readonly jobTables: number }> } {
  const result = composeDatabase(options);
  return { ...result, migrate: (dir) => {
    if (!result.ok) return Promise.reject(new Error('migration configuration refused'));
    return migrateAdapter(result.ctx.db, dir, result.ctx.config.database.migrationUrl ?? '', jobQueues(result.ctx.config.jobs.importExpireSeconds), (e) => { result.ctx.log.warn('jobs.queue_recreated', e); });
  } };
}
