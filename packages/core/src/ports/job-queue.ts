import type { Queryable } from './database.js';

export interface EnqueueOptions {
  /** Do not run the job before this many seconds have passed. */
  readonly delaySeconds?: number;
  /** At most one queued or running job per name and key; a second enqueue with the same key is dropped. */
  readonly singletonKey?: string;
  /** How many times a failing job is run again after its first failure. */
  readonly retryLimit?: number;
}

export interface JobContext {
  readonly id: string;
  /** 1 for the first run, 2 for the first retry, and so on. */
  readonly attempt: number;
}

/** Resolves when the job is done; rejects to fail it (it is then retried while retries remain). */
export type JobHandler<Payload = unknown> = (payload: Payload, context: JobContext) => Promise<void>;

/** Background jobs. */
export interface JobQueue {
  /**
   * Adds a job and returns its id, or `null` when a singleton job with the same key already exists.
   * With `tx` the job is written in that transaction, so it exists only if the transaction commits.
   */
  enqueue<Payload>(name: string, payload: Payload, options?: EnqueueOptions, tx?: Queryable): Promise<string | null>;
  /** Registers the handler that runs the jobs of `name`. */
  work<Payload>(name: string, handler: JobHandler<Payload>): Promise<void>;
  /** Enqueues `name` with `payload` on a five-field cron expression (UTC). Replaces an earlier schedule of the same name. */
  schedule(name: string, cron: string, payload?: unknown): Promise<void>;
}
