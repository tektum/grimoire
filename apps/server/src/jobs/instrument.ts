import type { Clock } from '@tektum/grimoire-core/ports/clock';
import type { JobHandler } from '@tektum/grimoire-core/ports/job-queue';
import type { EventLog } from '../events.js';

const MESSAGE_LIMIT = 200;

// eslint-disable-next-line no-control-regex -- the point is to take control characters out of a log line
const CONTROL = /[\u0000-\u001f\u007f]+/g;

/** Text of any value that cannot throw: a string as it is, anything else through `String`, and `''` when even that throws (a null-prototype object, a hostile `toString`). */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  try { return String(value); } catch { return ''; }
}

const clean = (text: string, limit: number): string => text.replace(CONTROL, ' ').slice(0, limit);

/**
 * The class of an error and its message cut short, with control characters replaced: enough to tell why a run failed, never the payload. A thrown value that is not an error is
 * `NonError`. An error with no message of its own (a connection refused on every address is an `AggregateError` with none) is described by its first inner error, or its `code`.
 * It never throws, so describing a failure can not replace the failure.
 */
export function reasonOf(error: unknown): { errorName: string; errorMessage: string } {
  if (!(error instanceof Error)) return { errorName: 'NonError', errorMessage: clean(textOf(error), MESSAGE_LIMIT) };
  const record = error as Error & { code?: unknown; errors?: unknown };
  let message = textOf(record.message);
  if (message === '') {
    const inner = Array.isArray(record.errors) ? (record.errors[0] as { message?: unknown } | undefined) : undefined;
    message = inner === undefined || inner === null ? '' : textOf(inner.message);
  }
  if (message === '' && typeof record.code === 'string') message = record.code;
  return { errorName: clean(textOf(record.name), 60), errorMessage: clean(message, MESSAGE_LIMIT) };
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
