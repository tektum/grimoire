import type { Config } from '@tektum/grimoire-core/ports/config';
import type { JobQueue } from '@tektum/grimoire-core/ports/job-queue';
import type { EventLog } from '../events.js';
import { SHUTDOWN_BUDGET_MS } from '../lifecycle/budget.js';
import type { ShutdownHook } from '../lifecycle/shutdown.js';
import { registerJobs } from './index.js';

export interface JobRunner {
  /** Starts the queue and registers the handlers; a second call does nothing. Rejects when the queue cannot start (the server then fails to start). */
  start(): Promise<void>;
  /** Stops the queue in the `release-jobs` phase, with the grace of the settings. */
  readonly hook: ShutdownHook;
}

/** What the queue is started with: the part of the adapter's options this module sets. */
export interface QueueStart {
  readonly connectionString: string;
  readonly stopGraceMs: number;
  readonly onError: (error: Error) => void;
}

export interface JobRunnerOptions {
  readonly config: Config;
  readonly log: EventLog;
  /** Constructs and starts the queue: `createJobQueue` of the pg-boss adapter (only the composition root constructs adapters), or a test's own. */
  readonly make: (options: QueueStart) => Promise<JobQueue>;
  readonly onError?: (error: Error) => void;
}

/** How long after a failed start the next one is tried. */
export const START_RETRY_MS = 30_000;
/** The starts tried in all (about ten minutes); after that the failure is logged for good and the server keeps running without jobs. */
export const MAX_START_ATTEMPTS = 20;

/**
 * The job queue of the roles `api` and `all` (never `collab`). Constructing it starts nothing: `start` connects, after the listener is up, and the hook stops it.
 * A queue that cannot start (the database is not migrated yet: the server runs in that state and says so on `/readyz`) is logged and tried again, so it does not stop the server.
 * A queue that started but could not register its handlers is stopped before the next try, so no attempt leaves one running. A stop waits for a start that is under way.
 * Schedules are not registered here: whether the runtime role may run pg-boss's cron loop is settled by the soak of M7-T02 (decision 13).
 */
export function createJobRunner(options: JobRunnerOptions): JobRunner {
  const { config, log } = options;
  let queue: JobQueue | undefined;
  let running = false;
  let stopped = false;
  let attempts = 0;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;
  const attempt = async (): Promise<void> => {
    timer = undefined;
    if (stopped || queue !== undefined) return;
    attempts++;
    let made: JobQueue | undefined;
    try {
      const url = config.database.url;
      if (url === undefined) throw new Error('the job queue needs the database url');
      made = await options.make({ connectionString: url, stopGraceMs: config.jobs.stopGraceMs, onError: options.onError ?? (() => undefined) });
      if (stopped) { queue = made; return; } // stopped while starting: no handler is registered, and the hook stops this queue
      for (const job of registerJobs({ config })) await made.work(job.name, job.handler);
      queue = made;
    } catch {
      // Nothing started here may keep running: a queue made but not set up is stopped now, with no grace (nothing is running on it).
      if (made !== undefined) await made.stop({ graceMs: 0 }).catch(() => undefined);
      if (attempts >= MAX_START_ATTEMPTS) { log.error('jobs.failed', { name: 'queue-start-gave-up', jobId: '-', attempt: attempts, ms: 0 }); return; }
      log.error('jobs.failed', { name: 'queue-start', jobId: '-', attempt: attempts, ms: 0 });
      if (!stopped) { timer = setTimeout(() => { inFlight = attempt(); }, START_RETRY_MS); timer.unref(); }
    }
  };
  return {
    start: async () => {
      if (running) return;
      running = true;
      inFlight = attempt();
      await inFlight;
    },
    hook: {
      name: 'jobs', phase: 'release-jobs', deadlineMs: config.jobs.stopGraceMs + SHUTDOWN_BUDGET_MS.jobsHookOverhead,
      run: async () => {
        stopped = true;
        if (timer !== undefined) clearTimeout(timer);
        await inFlight; // a start under way settles first, so shutdown cannot release what it is still using
        if (queue === undefined) return;
        const { inFlight: running } = await queue.stop({ graceMs: config.jobs.stopGraceMs });
        log.info('jobs.stopped', { inFlight: running });
      },
    },
  };
}
