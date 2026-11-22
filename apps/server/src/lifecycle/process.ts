import type { EventLog, ShutdownReason } from '../events.js';
import { errorName } from '../events.js';
import type { Shutdown } from './shutdown.js';

/** 0 clean, 1 a hook failed or a fault occurred, 2 configuration refused (also the CLI's), 3 shutdown forced. */
export const EXIT = { ok: 0, failure: 1, config: 2, forced: 3 } as const;

/** The slice of `process` used here, so tests can drive it without signalling the test runner. */
export interface SignalSource {
  onSignal(signal: 'SIGTERM' | 'SIGINT', listener: () => void): void;
  onFault(kind: 'uncaughtException' | 'unhandledRejection', listener: (reason: unknown) => void): void;
}

export const processSignals: SignalSource = {
  onSignal: (signal, listener) => { process.on(signal, listener); },
  onFault: (kind, listener) => { process.on(kind, listener); },
};

export interface ProcessHandlerOptions {
  readonly shutdown: Shutdown;
  readonly log: EventLog;
  readonly source: SignalSource;
  readonly exit: (code: number) => void;
  /** Backstop for the whole run; past it the process exits with EXIT.forced. */
  readonly overallDeadlineMs: number;
}

/**
 * First SIGTERM/SIGINT starts the shutdown; a second one, or the overall deadline, forces EXIT.forced.
 * An uncaught exception or unhandled rejection logs one event, attempts the same shutdown, and exits non-zero.
 */
export function installProcessHandlers(o: ProcessHandlerOptions): void {
  let started = false;
  let faulted = false;
  let backstop: NodeJS.Timeout | undefined;

  const begin = (reason: ShutdownReason): void => {
    started = true;
    backstop = setTimeout(() => {
      o.log.error('shutdown.forced', { reason: 'overall-deadline', deadlineMs: o.overallDeadlineMs });
      o.exit(EXIT.forced);
    }, o.overallDeadlineMs);
    void o.shutdown.run(o.log, reason).then((code) => {
      clearTimeout(backstop);
      o.exit(faulted ? EXIT.failure : code);
    });
  };

  const onSignal = (signal: 'SIGTERM' | 'SIGINT'): void => {
    if (started) {
      o.log.warn('shutdown.second_signal', { signal });
      o.log.error('shutdown.forced', { reason: 'second-signal', deadlineMs: o.overallDeadlineMs });
      o.exit(EXIT.forced);
      return;
    }
    begin(signal);
  };
  o.source.onSignal('SIGTERM', () => { onSignal('SIGTERM'); });
  o.source.onSignal('SIGINT', () => { onSignal('SIGINT'); });

  const onFault = (kind: 'uncaughtException' | 'unhandledRejection', reason: unknown): void => {
    o.log.error('process.fault', { kind, errorName: errorName(reason) });
    faulted = true;
    if (!started) begin(kind);
  };
  o.source.onFault('uncaughtException', (r) => { onFault('uncaughtException', r); });
  o.source.onFault('unhandledRejection', (r) => { onFault('unhandledRejection', r); });
}
