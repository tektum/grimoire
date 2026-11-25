import type { Clock } from '@tektum/grimoire-core/ports/clock';
import type { JobHandler } from '@tektum/grimoire-core/ports/job-queue';
import type { EventLog } from '../events.js';

/**
 * Wraps a handler so that each run is logged by id and number only: `jobs.started`, then `jobs.completed`; a failure is `jobs.retrying` while retries remain
 * and `jobs.failed` on the last run (the job then goes to the dead-letter queue); `jobs.aborted` when the signal had aborted by the time the handler returned.
 * A thrown error's message never reaches the log.
 */
export function instrument(name: string, handler: JobHandler, log: EventLog, clock: Clock): JobHandler {
  return async (payload, ctx) => {
    const started = clock.now();
    const event = (): { name: string; jobId: string; attempt: number; ms: number } => ({ name, jobId: ctx.jobId, attempt: ctx.attempt, ms: clock.now() - started });
    log.info('jobs.started', { ...event(), ms: 0 });
    try {
      await handler(payload, ctx);
    } catch (error) {
      if (ctx.signal.aborted) log.warn('jobs.aborted', { name, jobId: ctx.jobId });
      if (ctx.attempt > ctx.retryLimit) log.error('jobs.failed', event());
      else log.warn('jobs.retrying', event());
      throw error;
    }
    if (ctx.signal.aborted) log.warn('jobs.aborted', { name, jobId: ctx.jobId });
    log.info('jobs.completed', event());
  };
}
