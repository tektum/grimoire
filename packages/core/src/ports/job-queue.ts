import type { Queryable } from './database.js';

/**
 * How a queue treats a `singletonKey`. `standard` ignores it (two sends both create a job). `short` and `stately` allow one
 * queued job per key and answer a second send with the id of the queued one; `stately` also lets one job per key run, so a
 * running handler may enqueue its own continuation under its own key. `singleton` runs one job at a time and queues any number.
 */
export type QueuePolicy = 'standard' | 'short' | 'singleton' | 'stately';

/** Everything a queue is created with. Times are seconds. */
export interface QueueDefinition {
  readonly name: string;
  readonly policy: QueuePolicy;
  /** How many times a failing job is run again after its first failure (a send may override it). */
  readonly retryLimit: number;
  readonly retryDelaySeconds: number;
  /** Double the delay at every retry. */
  readonly retryBackoff: boolean;
  /** A running job that has not finished after this long is given back to the queue (a send may override it). */
  readonly expireInSeconds: number;
  /** How long a job that is waiting is kept. */
  readonly retentionSeconds: number;
  /** The queue that receives a job that has used all its retries. It must exist before this queue is created. */
  readonly deadLetter?: string;
}

export interface EnqueueOptions {
  /** Do not run the job before this many seconds have passed. */
  readonly delaySeconds?: number;
  /** Needs a queue whose policy is not `standard`. A second send while one job with the key is queued returns that job's id. */
  readonly singletonKey?: string;
  /** Overrides the queue's `retryLimit` for this job. */
  readonly retryLimit?: number;
  /** Overrides the queue's `expireInSeconds` for this job. */
  readonly expireInSeconds?: number;
}

export interface JobContext {
  readonly jobId: string;
  /** 1 for the first run, 2 for the first retry, and so on. */
  readonly attempt: number;
  readonly retryLimit: number;
  /**
   * Aborts when the job's expiry is near and when `stop` runs out of grace. A handler that exceeds its expiry is given back
   * to the queue while its code keeps running, so handlers are idempotent and check this between steps.
   */
  readonly signal: AbortSignal;
}

/** Resolves when the job is done; rejects to fail it (it is then retried while retries remain). A return after the signal aborted counts as done. */
export type JobHandler<Payload = unknown> = (payload: Payload, context: JobContext) => Promise<void>;

/** Milliseconds after a job starts when its signal aborts: its expiry minus a minute, or half of it when that is shorter. */
export function expirySignalDelayMs(expireInSeconds: number): number {
  return (expireInSeconds - Math.min(60, expireInSeconds / 2)) * 1000;
}

/** Background jobs. Every payload of a tenant's job carries `tenantId`, and its handler loads rows with it. */
export interface JobQueue {
  /** Creates the queue unless it exists (an existing one is left as it is). Run it before `work`, `schedule` or `enqueue` use the name. */
  ensureQueue(definition: QueueDefinition): Promise<void>;
  /**
   * Adds a job and returns its id: the existing job's when a singleton key finds a queued one, `null` when no job was added.
   * With `tx` the job is written in that transaction, so it exists only if the transaction commits.
   */
  enqueue<Payload>(name: string, payload: Payload, options?: EnqueueOptions, tx?: Queryable): Promise<string | null>;
  /** True while a job of `name` with `singletonKey` is queued, waiting for a retry or running. */
  isLive(name: string, singletonKey: string): Promise<boolean>;
  /** Registers the handler that runs the jobs of `name`. */
  work<Payload>(name: string, handler: JobHandler<Payload>): Promise<void>;
  /**
   * Enqueues `name` with `payload` on a five-field cron expression (UTC). Replaces an earlier schedule of the same name. Call it at every start of every process that works the
   * queue: a schedule lives in the queue, not in the process, and calling it again changes nothing. The queue must be `stately`.
   */
  schedule(name: string, cron: string, payload?: unknown): Promise<void>;
  /**
   * Stops taking jobs at once and waits up to `graceMs` for running handlers; the signals of those still running abort at
   * `graceMs - 2000` (at once when the grace is shorter). Resolves with how many handlers were still running at the end.
   */
  stop(options: { graceMs: number }): Promise<{ inFlight: number }>;
}
