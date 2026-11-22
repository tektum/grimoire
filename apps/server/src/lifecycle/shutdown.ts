import type { Clock } from '@tektum/grimoire-core/ports/clock';
import type { EventLog, ShutdownPhaseName, ShutdownReason } from '../events.js';
import { errorName } from '../events.js';

/** Phases in the order R4.25 runs them. */
export const SHUTDOWN_PHASES = ['stop-accepting', 'stop-timers', 'save-pages', 'release-jobs', 'close-database'] as const satisfies readonly ShutdownPhaseName[];
export type ShutdownPhase = (typeof SHUTDOWN_PHASES)[number];

export interface ShutdownHook {
  readonly name: string;
  readonly phase: ShutdownPhase;
  readonly deadlineMs: number;
  run(): Promise<void>;
}

/** 0 every hook succeeded, 1 a hook threw or timed out. */
export type ShutdownResult = 0 | 1;

/**
 * Ordered shutdown. Phases run one after another; hooks of a phase are started in registration order and run in
 * parallel (contracts section 5). A hook past its deadline is abandoned; a throw is logged; neither stops later phases.
 * Deadlines use setTimeout (timers are the only way to abandon a promise); durations come from the Clock port.
 */
export class Shutdown {
  private readonly hooks: ShutdownHook[] = [];
  private draining = false;
  private result: Promise<ShutdownResult> | undefined;

  constructor(private readonly clock: Clock) {}

  register(hook: ShutdownHook): void {
    if (this.draining) throw new Error('shutdown has started; hooks can no longer be registered');
    this.hooks.push(hook);
  }

  /** True from the moment shutdown starts, before any hook runs. */
  isDraining(): boolean {
    return this.draining;
  }

  /** Idempotent: a second call returns the first run's result. */
  run(log: EventLog, reason: ShutdownReason): Promise<ShutdownResult> {
    this.draining = true; // /readyz reads this; set synchronously, before any hook starts
    this.result ??= this.runPhases(log, reason);
    return this.result;
  }

  /** The cleanup of a failed start: the same single run as `run()` (draining is set and a signal that arrives meanwhile joins it instead of running the hooks a second time). */
  runStartupFailure(log: EventLog): Promise<ShutdownResult> {
    this.draining = true;
    this.result ??= this.runHooks(log);
    return this.result;
  }

  private async runPhases(log: EventLog, reason: ShutdownReason): Promise<ShutdownResult> {
    log.info('shutdown.started', { reason });
    return this.runHooks(log);
  }

  private async runHooks(log: EventLog): Promise<ShutdownResult> {
    let failed = false;
    for (const phase of SHUTDOWN_PHASES) {
      const inPhase = this.hooks.filter((h) => h.phase === phase);
      if (inPhase.length === 0) continue;
      log.info('shutdown.phase_started', { phase, hooks: inPhase.length });
      const outcomes = await Promise.all(inPhase.map((h) => this.runHook(h, log)));
      if (outcomes.includes(false)) failed = true;
    }
    const exitCode: ShutdownResult = failed ? 1 : 0;
    log.info('shutdown.completed', { exitCode });
    return exitCode;
  }

  private async runHook(hook: ShutdownHook, log: EventLog): Promise<boolean> {
    const started = this.clock.now();
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), hook.deadlineMs);
    });
    try {
      const running = Promise.resolve().then(() => hook.run());
      running.catch(() => undefined); // an abandoned hook may still reject later; that must not become an unhandled rejection
      const outcome = await Promise.race([running.then(() => 'done' as const), timedOut]);
      if (outcome === 'timeout') {
        log.warn('shutdown.hook_timeout', { hook: hook.name, phase: hook.phase, deadlineMs: hook.deadlineMs });
        return false;
      }
      log.info('shutdown.hook_done', { hook: hook.name, phase: hook.phase, ms: this.clock.now() - started });
      return true;
    } catch (e) {
      log.error('shutdown.hook_failed', { hook: hook.name, phase: hook.phase, errorName: errorName(e) });
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
