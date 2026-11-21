import { pino } from 'pino';
import type { Logger as PinoLogger } from 'pino';
import type { Clock } from '@tektum/grimoire-core/ports/clock';
import type { Logger, LogLevel } from '@tektum/grimoire-core/ports/logger';
import { redactString, scrubFields } from './scrub.js';

export { redactString } from './scrub.js';

export interface JsonLoggerOptions {
  readonly level?: LogLevel;
  /** Receives pino's output (one JSON line ending in a newline). Defaults to standard output. */
  readonly destination?: { write(line: string): unknown };
  readonly clock?: Clock;
  readonly fields?: Record<string, unknown>;
}

// First layer: pino's own path redaction for the known secret names (one level deep).
const SECRET_NAMES = ['token', 'password', 'passwd', 'pwd', 'secret', 'authorization', 'cookie', 'apikey', 'api_key', 'access_key', 'secret_key', 'session', 'credential', 'credentials'];
const REDACT_PATHS = SECRET_NAMES.flatMap((n) => [n, `*.${n}`]);

interface TsState { value: string }

function wrap(p: PinoLogger, ts: TsState, now: () => string | undefined): Logger {
  const emit = (level: LogLevel, event: string, fields?: Record<string, unknown>): void => {
    try {
      const t = now();
      ts.value = t ?? new Date().toISOString();
      const clean = scrubFields(fields);
      if (t === undefined) clean['clockFallback'] = true;
      p[level](clean, redactString(String(event)));
    } catch {
      // The logger never throws into its caller.
    }
  };
  return {
    debug: (e, f) => emit('debug', e, f),
    info: (e, f) => emit('info', e, f),
    warn: (e, f) => emit('warn', e, f),
    error: (e, f) => emit('error', e, f),
    child: (fields) => {
      try {
        return wrap(p.child(scrubFields(fields)), ts, now);
      } catch {
        return wrap(p, ts, now);
      }
    },
  };
}

export function createJsonLogger(opts: JsonLoggerOptions = {}): Logger {
  const clock = opts.clock;
  // The clock is read once per event; an unusable reading falls back to real time and the event
  // carries `clockFallback: true`.
  const now = (): string | undefined => {
    try {
      return new Date(clock ? clock.now() : Date.now()).toISOString();
    } catch {
      return undefined;
    }
  };
  const ts: TsState = { value: new Date().toISOString() };
  const options = {
    level: opts.level ?? 'info',
    messageKey: 'event',
    base: null,
    timestamp: (): string => `,"ts":"${ts.value}"`,
    formatters: { level: (label: string) => ({ level: label }) },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  };
  const root = opts.destination ? pino(options, opts.destination) : pino(options);
  return wrap(opts.fields ? root.child(scrubFields(opts.fields)) : root, ts, now);
}
