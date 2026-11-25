import type { Config } from '@tektum/grimoire-core/ports/config';
import type { Clock } from '@tektum/grimoire-core/ports/clock';
import type { EnqueueOptions, JobQueue } from '@tektum/grimoire-core/ports/job-queue';
import type { EventLog } from '../events.js';
import { SHUTDOWN_BUDGET_MS } from '../lifecycle/budget.js';
import type { ShutdownHook } from '../lifecycle/shutdown.js';
import { importJobs, type RegisteredJob } from './index.js';
import { instrument, reasonOf } from './instrument.js';

/** `starting`: not registered yet (trying, or waiting to try again); `up`; `down`: gave up after the last start failed; `stopped`: shut down. */
export type JobsState = 'starting' | 'up' | 'down' | 'stopped';

/** What the code that is not a job handler's own reaches the queue by: the import's job and its cleanup, and whether an import's job is live. All reject with `jobs-unavailable` while the queue is not up (not started, given up, or stopping). */
export interface JobsApi {
  isLive(name: string, singletonKey: string): Promise<boolean>;
  /** Hands the job of an import to the queue (the import start, the sweep): its payload is the ids and nothing else (decision 4). */
  enqueueImport(payload: { readonly importId: string; readonly tenantId: string }, options?: EnqueueOptions): Promise<string | null>;
  /** Hands the cleanup of an import that is over to the queue (a cancel, the sweep): ids only. */
  enqueueImportCleanup(payload: { readonly importId: string; readonly tenantId: string }): Promise<string | null>;
}

export interface JobRunner extends JobsApi {
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
  /** The jobs to register: `registerJobs` of the composition root, given the queue's `JobsApi` (a job that asks about or adds another job reaches the queue through it). Without it only the `import` job is. */
  readonly jobs?: readonly RegisteredJob[] | ((queue: JobsApi) => readonly RegisteredJob[]);
  /** The time of the run log (`jobs.started` and the rest carry the milliseconds a run took). */
  readonly clock?: Clock;
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
 * Schedules are registered here, at every start of every replica, and are a chain of sends (decision 16): pg-boss's cron loop cannot start on the runtime role. A schedule that cannot be sent fails the start like a handler does.
 */
export function createJobRunner(options: JobRunnerOptions): JobRunner {
  const { config, log } = options;
  const clock = options.clock ?? { now: () => Date.now() };
  let queue: JobQueue | undefined;
  let running = false;
  let stopped = false;
  /** The stop gave up waiting for the start under way: the queue it makes later is stopped by the attempt, not by the hook. */
  let abandoned = false;
  let attempts = 0;
  let state: JobsState = 'starting';
  const up = (): JobQueue => {
    if (queue === undefined || state !== 'up') throw new Error('jobs-unavailable');
    return queue;
  };
  const api: JobsApi = {
    isLive: (name, key) => Promise.resolve().then(() => up().isLive(name, key)),
    enqueueImport: (payload, enqueueOptions) => Promise.resolve().then(() => up().enqueue('import', { importId: payload.importId, tenantId: payload.tenantId }, enqueueOptions)),
    enqueueImportCleanup: (payload) => Promise.resolve().then(() => up().enqueue('import-cleanup', { importId: payload.importId, tenantId: payload.tenantId }, { singletonKey: `import-cleanup:${payload.importId}` })),
  };
  const jobs = typeof options.jobs === 'function' ? options.jobs(api) : (options.jobs ?? importJobs());
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
        for (const job of jobs) {
          if (stopped) break; // a stop that comes in the middle: no handler is registered after it, so no job starts during the drain
          await made.work(job.name, instrument(job.name, job.handler, log, clock));
          if (job.schedule !== undefined) await made.schedule(job.name, job.schedule); // after the handler, so the run it sends is worked; every replica does it at every start
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
    } catch (error) {
      // Nothing started here may keep running: a queue made but not set up is stopped now, with no grace (nothing is running on it).
      if (made !== undefined) await made.stop({ graceMs: 0 }).catch(() => undefined);
      if (stopped) return; // a start that fails after the stop began changes nothing: the state stays `stopped`, and no event says jobs are unavailable
      if (attempts >= MAX_START_ATTEMPTS) { state = 'down'; log.error('jobs.unavailable', { attempts }); return; }
      log.error('jobs.failed', { name: 'queue-start', jobId: '-', attempt: attempts, ms: 0, ...reasonOf(error) });
      if (!stopped) { timer = setTimeout(() => { inFlight = attempt(); }, START_RETRY_MS); timer.unref(); }
    } finally {
      attempting = false;
    }
  };
  return {
    state: () => state,
    ...api,
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
          // Not for ever, by decision: shutdown never waits on a hung database for jobs. What the late attempt may still do is bounded: it registers no handler once `stopped` is set, and
          // it stops its own queue with no grace when it ends.
          if (!settled) { abandoned = true; return; }
        }
        if (queue === undefined) return;
        const { inFlight: running } = await queue.stop({ graceMs: waiting ? Math.max(1, config.jobs.stopGraceMs - (Date.now() - began)) : config.jobs.stopGraceMs });
        log.info('jobs.stopped', { inFlight: running });
      },
    },
  };
}
