import type { QueueDefinition } from '../ports/job-queue.js';

const common = { retryLimit: 3, retryDelaySeconds: 30, retryBackoff: true, retentionSeconds: 14 * 24 * 3600 } as const;
const withDeadLetter = { ...common, deadLetter: 'dead-letter' } as const;

/**
 * The singleton key of a scheduled queue's next run (decision 16): the adapter's cron chain and the embed sweep's chain (amendment 16a) send their runs under it, so the runs every
 * replica sends collapse into one waiting run, and `grimoire migrate` finds a waiting run by it.
 */
export const scheduleKey = (name: string): string => `sched:${name}`;

/**
 * Every queue the application uses, the dead-letter queue first (a queue can only name one that exists). `grimoire migrate`
 * creates them; times are seconds. The scheduled queues are `stately`: one waiting run per `singletonKey` (the scheduler's `sched:<name>`) and one running, so replicas that send the next run at start collapse into one. `importExpireSeconds` is the expiry of one import chunk (`GRIMOIRE_JOBS_IMPORT_EXPIRE_SECONDS`).
 */
export function jobQueues(importExpireSeconds = 900): readonly QueueDefinition[] {
  return [
    { ...common, name: 'dead-letter', policy: 'standard', expireInSeconds: 600 },
    { ...withDeadLetter, name: 'import', policy: 'stately', expireInSeconds: importExpireSeconds },
    { ...withDeadLetter, name: 'import-sweep', policy: 'stately', expireInSeconds: 300 },
    { ...withDeadLetter, name: 'import-cleanup', policy: 'stately', expireInSeconds: 600 },
    { ...withDeadLetter, name: 'purge', policy: 'stately', expireInSeconds: 3600 },
    { ...withDeadLetter, name: 'upload-cleanup', policy: 'stately', expireInSeconds: 600 },
    { ...withDeadLetter, name: 'revision-catchup', policy: 'stately', expireInSeconds: 1800 },
    { ...withDeadLetter, name: 'markdown-sweep', policy: 'stately', expireInSeconds: 300 },
    { ...withDeadLetter, name: 'embed-sweep', policy: 'stately', expireInSeconds: 300 },
    { ...withDeadLetter, name: 'embed-page', policy: 'stately', expireInSeconds: 600 },
  ];
}
