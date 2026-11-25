import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { DERIVED_BUDGETS_MS, SHUTDOWN_BUDGET_MS, overallShutdownDeadlineMs, releaseJobsPhaseMs, requiredGracePeriodMs, shutdownPhaseSumMs } from '../../src/lifecycle/budget.js';

describe('one shutdown deadline budget', () => {
  it('has no literal 5000 or 4000 deadlines in wiring code', () => {
    expect(() => execFileSync('grep', ['-rn', '5000\\|4000', 'apps/server/src/lifecycle/run.ts', 'apps/server/src/composition.ts', 'apps/server/src/collab/index.ts'], { stdio: 'pipe' })).toThrow();
  });

  it('the release-jobs phase is as long as the longest hook in it: the pool, or the jobs\' stop grace plus its overhead', () => {
    expect(releaseJobsPhaseMs(0)).toBe(DERIVED_BUDGETS_MS.releaseJobs);
    expect(releaseJobsPhaseMs(1500)).toBe(DERIVED_BUDGETS_MS.releaseJobs);
    expect(releaseJobsPhaseMs(15_000)).toBe(15_000 + SHUTDOWN_BUDGET_MS.jobsHookOverhead);
  });

  it('derives the hook deadlines from the table', () => {
    expect(DERIVED_BUDGETS_MS.poolClose).toBe(SHUTDOWN_BUDGET_MS.poolWork);
    expect(DERIVED_BUDGETS_MS.releaseJobs).toBe(SHUTDOWN_BUDGET_MS.poolWork + SHUTDOWN_BUDGET_MS.poolHookOverhead);
    expect(DERIVED_BUDGETS_MS.httpStopAccepting).toBe(SHUTDOWN_BUDGET_MS.drainPropagation + SHUTDOWN_BUDGET_MS.httpDrain + SHUTDOWN_BUDGET_MS.httpSweepMargin);
  });

  it('the default numbers: save keeps its whole 45 s, the jobs get their 15 s grace, the backstop is 72.5 s, the grace period 77.5 s; a role without jobs keeps the old 59 s and 64 s', () => {
    expect(shutdownPhaseSumMs(45_000, 15_000)).toBe(45_000 + 2000 + 5000 + 15_500 + 1000 + 2000);
    expect(shutdownPhaseSumMs(45_000, 15_000)).toBe(70_500);
    expect(overallShutdownDeadlineMs(45_000, 15_000)).toBe(72_500);
    expect(requiredGracePeriodMs(45_000, 15_000)).toBe(77_500);
    expect(overallShutdownDeadlineMs(45_000, 0)).toBe(59_000);
    expect(requiredGracePeriodMs(45_000, 0)).toBe(64_000);
  });

  it('sum of the phase deadlines <= backstop <= required grace period, for every save deadline the loader accepts (1 ms to its maximum)', () => {
    for (const save of [1, 1000, 45_000, 600_000, 2_147_483_647]) {
      for (const jobs of [0, 1500, 15_000, 120_000]) {
        expect(shutdownPhaseSumMs(save, jobs), `save ${String(save)}, jobs ${String(jobs)}`).toBeLessThanOrEqual(overallShutdownDeadlineMs(save, jobs));
        expect(overallShutdownDeadlineMs(save, jobs), `save ${String(save)}, jobs ${String(jobs)}`).toBeLessThan(requiredGracePeriodMs(save, jobs));
      }
    }
  });
});
