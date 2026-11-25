import type { Config } from '@tektum/grimoire-core/ports/config';
import type { JobQueue } from '@tektum/grimoire-core/ports/job-queue';
import type { EventLog } from '../events.js';
import { SHUTDOWN_BUDGET_MS } from '../lifecycle/budget.js';
import type { ShutdownHook } from '../lifecycle/shutdown.js';
import { registerJobs } from './index.js';

/** `starting`: not registered yet (trying, or waiting to try again); `up`; `down`: gave up after the last start failed; `stopped`: shut down. */
export type JobsState = 'starting' | 'up' | 'down' | 'stopped';

export interface JobRunner {
  state(): JobsState;
  /** Starts the queue and registers the handlers; a second call does nothing. It never rejects: a start that fails is logged and tried again (`MAX_START_ATTEMPTS` times), and the server keeps running. */
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
/** How long a stop waits for a start that is still under way (a database that does not answer must not hold shutdown for the whole grace). */
export const START_STOP_WAIT_MS = 1000;
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
  /** The stop gave up waiting for the start under way: the queue it makes later is stopped by the attempt, not by the hook. */
  let abandoned = false;
  let attempts = 0;
  let state: JobsState = 'starting';
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;
  /** True while an attempt is running (the stop then waits for it, and that wait is taken out of the grace). */
  let attempting = false;
  const attempt = async (): Promise<void> => {
    timer = undefined;
    if (stopped || queue !== undefined) return;
    attempts++;
    attempting = true;
    let made: JobQueue | undefined;
    try {
      const url = config.database.url;
      if (url === undefined) throw new Error('the job queue needs the database url');
      made = await options.make({ connectionString: url, stopGraceMs: config.jobs.stopGraceMs, onError: options.onError ?? (() => undefined) });
      if (!stopped) {
        for (const job of registerJobs({ config })) {
          if (stopped) break; // a stop that comes in the middle: no handler is registered after it, so no job starts during the drain
          await made.work(job.name, job.handler);
        }
      }
      if (stopped) {
        // Stopped while starting: the hook stops this queue (with the handlers registered so far), or the attempt does when the hook has given up waiting for it.
        if (abandoned) await made.stop({ graceMs: 0 }).catch(() => undefined);
        else queue = made;
        return;
      }
      queue = made;
      state = 'up';
    } catch {
      // Nothing started here may keep running: a queue made but not set up is stopped now, with no grace (nothing is running on it).
      if (made !== undefined) await made.stop({ graceMs: 0 }).catch(() => undefined);
      if (attempts >= MAX_START_ATTEMPTS) { state = 'down'; log.error('jobs.unavailable', { attempts }); return; }
      log.error('jobs.failed', { name: 'queue-start', jobId: '-', attempt: attempts, ms: 0 });
      if (!stopped) { timer = setTimeout(() => { inFlight = attempt(); }, START_RETRY_MS); timer.unref(); }
    } finally {
      attempting = false;
    }
  };
  return {
    state: () => state,
    start: async () => {
      if (running) return;
      running = true;
      inFlight = attempt();
      await inFlight;
    },
    hook: {
      name: 'jobs', phase: 'release-jobs', deadlineMs: config.jobs.stopGraceMs + SHUTDOWN_BUDGET_MS.jobsHookOverhead,
      run: async () => {
        const began = Date.now();
        const waiting = attempting; // a start is under way: the stop waits for it, and the wait comes out of the grace
        stopped = true;
        if (state !== 'down') state = 'stopped';
        if (timer !== undefined) clearTimeout(timer);
        if (inFlight !== undefined) {
          // A start under way settles first, so shutdown cannot release what it is still using; but only for a part of the grace, so the wait and the stop together fit it.
          const waitMs = Math.min(START_STOP_WAIT_MS, Math.floor(config.jobs.stopGraceMs / 2));
          let wait: NodeJS.Timeout | undefined;
          const settled = await Promise.race([inFlight.then(() => true), new Promise<boolean>((resolve) => { wait = setTimeout(() => { resolve(false); }, waitMs); wait.unref(); })]);
          if (wait !== undefined) clearTimeout(wait);
          if (!settled) { abandoned = true; return; }
        }
        if (queue === undefined) return;
        const { inFlight: running } = await queue.stop({ graceMs: waiting ? Math.max(1, config.jobs.stopGraceMs - (Date.now() - began)) : config.jobs.stopGraceMs });
        log.info('jobs.stopped', { inFlight: running });
      },
    },
  };
}
