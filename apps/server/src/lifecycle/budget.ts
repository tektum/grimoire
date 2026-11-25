/**
 * The shutdown time budget, in one place. Three numbers must agree, in this order:
 *   the orchestrator's grace period (compose.yaml `stop_grace_period`)  >=  the overall backstop  >=  the sum of the phase deadlines.
 * The save phase (flushing unsaved edits, the only phase that protects user data) keeps its full configured time (`GRIMOIRE_SHUTDOWN_SAVE_DEADLINE_MS`);
 * every other phase has a small fixed allowance, and the backstop is derived from all of them.
 */
export const SHUTDOWN_BUDGET_MS = {
  drainPropagation: 1000,
  httpDrain: 3000,
  httpSweepMargin: 1000,
  collabStopAccepting: 5000,
  poolWork: 1500,
  poolHookOverhead: 500,
  /** What the `jobs` hook adds to the stop grace it gives the queue: the queue's own bookkeeping after the grace. */
  jobsHookOverhead: 500,
  stopTimers: 1000,
  closeDatabase: 2000,
  saveLead: 2000,
  backstopMargin: 2000,
  /** Slack the container's grace period keeps over the backstop. */
  graceMargin: 5000,
} as const;
export const DERIVED_BUDGETS_MS = {
  /** The Markdown pool's own deadline for running work when it closes. */
  poolClose: SHUTDOWN_BUDGET_MS.poolWork,
  /** The Markdown pool's shutdown hook (the `release-jobs` phase; the jobs hook adds its own, see `releaseJobsPhaseMs`). */
  releaseJobs: SHUTDOWN_BUDGET_MS.poolWork + SHUTDOWN_BUDGET_MS.poolHookOverhead,
  httpStopAccepting: SHUTDOWN_BUDGET_MS.drainPropagation + SHUTDOWN_BUDGET_MS.httpDrain + SHUTDOWN_BUDGET_MS.httpSweepMargin,
  stopTimers: SHUTDOWN_BUDGET_MS.stopTimers,
  closeDatabase: SHUTDOWN_BUDGET_MS.closeDatabase,
} as const;

/** The `stop-accepting` phase runs the HTTP and collaboration hooks in parallel: the longer one counts. */
const stopAcceptingMs = (): number => Math.max(DERIVED_BUDGETS_MS.httpStopAccepting, SHUTDOWN_BUDGET_MS.collabStopAccepting);

/**
 * The `release-jobs` phase runs its hooks in parallel, so it lasts as long as the longest: the Markdown pool's, or the job queue's stop grace plus its overhead.
 * `jobsStopGraceMs` is `GRIMOIRE_JOBS_STOP_GRACE_MS` for a role that runs jobs and 0 for one that does not.
 */
export function releaseJobsPhaseMs(jobsStopGraceMs: number): number {
  return jobsStopGraceMs === 0 ? DERIVED_BUDGETS_MS.releaseJobs : Math.max(DERIVED_BUDGETS_MS.releaseJobs, jobsStopGraceMs + SHUTDOWN_BUDGET_MS.jobsHookOverhead);
}

/** The sum of the phase deadlines in the worst case (every phase uses its whole deadline, one after the other). */
export function shutdownPhaseSumMs(saveDeadlineMs: number, jobsStopGraceMs: number): number {
  return stopAcceptingMs() + saveDeadlineMs + SHUTDOWN_BUDGET_MS.saveLead + releaseJobsPhaseMs(jobsStopGraceMs) + DERIVED_BUDGETS_MS.stopTimers + DERIVED_BUDGETS_MS.closeDatabase;
}

/** The backstop for the whole run: the phase sum plus a small margin. Past it the process exits with the forced code. */
export function overallShutdownDeadlineMs(saveDeadlineMs: number, jobsStopGraceMs: number): number {
  return shutdownPhaseSumMs(saveDeadlineMs, jobsStopGraceMs) + SHUTDOWN_BUDGET_MS.backstopMargin;
}

/** What the container's grace period must be at least, for a given save deadline. */
export function requiredGracePeriodMs(saveDeadlineMs: number, jobsStopGraceMs: number): number {
  return overallShutdownDeadlineMs(saveDeadlineMs, jobsStopGraceMs) + SHUTDOWN_BUDGET_MS.graceMargin;
}
