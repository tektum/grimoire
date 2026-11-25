import type { Clock } from '@tektum/grimoire-core/ports/clock';
import type { JobHandler } from '@tektum/grimoire-core/ports/job-queue';
import type { EventLog } from '../events.js';

const MESSAGE_LIMIT = 200;

/** The class of an error and its message cut short, with control characters replaced: enough to tell why a run failed, never the payload. A thrown value that is not an error is `NonError`. */
export function reasonOf(error: unknown): { errorName: string; errorMessage: string } {
  const isError = error instanceof Error;
  // eslint-disable-next-line no-control-regex -- the point is to take control characters out of a log line
  const clean = (text: string): string => text.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, MESSAGE_LIMIT);
  return { errorName: isError ? clean(error.name).slice(0, 60) : 'NonError', errorMessage: clean(isError ? error.message : String(error)) };
}

/**
 * Wraps a handler so that each run is logged by id and number only: `jobs.started`, then `jobs.completed`; a failure is `jobs.retrying` while retries remain
 * and `jobs.failed` on the last run (the job then goes to the dead-letter queue); `jobs.aborted` when the signal had aborted by the time the handler returned.
 * A failure says why: the class of the error and its message, cut (`reasonOf`), never the payload.
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
      const why = reasonOf(error);
      if (ctx.attempt > ctx.retryLimit) log.error('jobs.failed', { ...event(), ...why });
      else log.warn('jobs.retrying', { ...event(), ...why });
      throw error;
    }
    if (ctx.signal.aborted) log.warn('jobs.aborted', { name, jobId: ctx.jobId });
    log.info('jobs.completed', event());
  };
}
