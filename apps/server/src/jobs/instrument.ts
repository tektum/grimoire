import type { Clock } from '@tektum/grimoire-core/ports/clock';
import type { JobHandler } from '@tektum/grimoire-core/ports/job-queue';
import type { EventLog } from '../events.js';

const MESSAGE_LIMIT = 200;
/** How much of a message is read before it is cut to `MESSAGE_LIMIT`: well above it, so a value that starts inside the limit and ends after it is still taken out, and small enough that the patterns cannot be made to cost seconds by a message of a few hundred KB with no spaces. */
const REDACT_WINDOW = 8 * MESSAGE_LIMIT;

// eslint-disable-next-line no-control-regex -- the point is to take control characters out of a log line
const CONTROL = /[\u0000-\u001f\u007f]+/g;

/** Text of any value that cannot throw: a string as it is, nothing for `undefined` and `null`, anything else through `String`, and `''` when even that throws (a null-prototype object, a hostile `toString`). */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try { return String(value); } catch { return ''; }
}

const clean = (text: string, limit: number): string => text.replace(CONTROL, ' ').slice(0, limit);

const URL_LIKE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
const EMAIL_LIKE = /[^\s<>"'`()[\]@]+@[^\s<>"'`()[\]@]+\.[^\s<>"'`()[\]@]+/g;
/** A quoted literal: "..." or `...`, and '...' unless the quote is an apostrophe inside a word; a quote that is never closed takes the rest of the message. */
const QUOTED = /"[^"]*"|`[^`]*`|(?<!\w)'[^']*'/g;
const UNCLOSED = /(?:"[^"]*|`[^`]*|(?<!\w)'[^']*)$/; // each kind of quote runs to the end of the message against itself only: another kind inside it does not end it
const PLACEHOLDER = { url: '<url>', email: '<email>', value: '<value>' } as const;

/**
 * A message with the values taken out: pg and the drivers echo what they refused (`invalid input syntax for type uuid: "<value>"`), a connection error names its URL with the credentials,
 * and some of our own errors interpolate what a person typed. URLs, email-like tokens and quoted literals become a placeholder; what is left says which rule was broken.
 * Only the first `REDACT_WINDOW` characters are read (the rest is never logged anyway).
 */
function redact(message: string): string {
  return message.slice(0, REDACT_WINDOW).replace(URL_LIKE, PLACEHOLDER.url).replace(EMAIL_LIKE, PLACEHOLDER.email).replace(QUOTED, PLACEHOLDER.value).replace(UNCLOSED, PLACEHOLDER.value);
}

/** An SQLSTATE (`22P02`) or an errno name (`ECONNREFUSED`): capitals, digits and underscores only, so a code that carries anything else is not logged. */
const CODE = /^[A-Z0-9_]{2,40}$/;
const codeOf = (value: unknown): string | undefined => (typeof value === 'string' && CODE.test(value) ? value : undefined);

export interface JobReason { readonly errorName: string; readonly errorCode?: string; readonly errorMessage: string }

/**
 * Why a run failed, safe to log: the class of the error, its SQLSTATE or errno when it has one, and its message with the values taken out (`redact`), control characters replaced and
 * cut to 200 characters. A thrown value that is not an error is `NonError`. An error with no message of its own (a connection refused on every address is an `AggregateError` with none)
 * is described by its first inner error, or its code. It never throws, so describing a failure can not replace the failure.
 */
export function reasonOf(error: unknown): JobReason {
  try {
    if (!(error instanceof Error)) return { errorName: 'NonError', errorMessage: clean(redact(textOf(error)), MESSAGE_LIMIT) };
    const record = error as Error & { code?: unknown; errors?: unknown };
    const inner = Array.isArray(record.errors) ? (record.errors[0] as { message?: unknown; code?: unknown } | null | undefined) : undefined;
    const errorCode = codeOf(record.code) ?? (inner === undefined || inner === null ? undefined : codeOf(inner.code));
    let message = textOf(record.message);
    if (message === '') message = inner === undefined || inner === null ? '' : textOf(inner.message);
    if (message === '' && errorCode !== undefined) message = errorCode;
    return { errorName: clean(textOf(record.name), 60), ...(errorCode === undefined ? {} : { errorCode }), errorMessage: clean(redact(message), MESSAGE_LIMIT) };
  } catch {
    return { errorName: 'Error', errorMessage: '' }; // a getter or a proxy that throws: the class is all that is known
  }
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
