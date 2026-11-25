import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { DEFAULT_STOP_GRACE_MS } from '@tektum/grimoire-adapter-jobs-pgboss';
import { loadConfig } from '@tektum/grimoire-adapter-config-env';
import { placeholderDatabaseUrl } from '@tektum/grimoire-core/testing/database-url';
import { DERIVED_BUDGETS_MS, JOBS_STOP_GRACE_MAX_MS, SHUTDOWN_BUDGET_MS, overallShutdownDeadlineMs, requiredGracePeriodMs, shutdownPhaseSumMs } from '../../src/lifecycle/budget.js';

describe('one shutdown deadline budget', () => {
  it('has no literal 5000 or 4000 deadlines in wiring code', () => {
    expect(() => execFileSync('grep', ['-rn', '5000\\|4000', 'apps/server/src/lifecycle/run.ts', 'apps/server/src/composition.ts', 'apps/server/src/collab/index.ts'], { stdio: 'pipe' })).toThrow();
  });

  it('the job queue\'s default stop timeout fits inside the release-jobs step', () => {
    expect(DEFAULT_STOP_GRACE_MS).toBeLessThanOrEqual(DERIVED_BUDGETS_MS.releaseJobs);
  });

  it('derives the hook deadlines from the table', () => {
    expect(DERIVED_BUDGETS_MS.poolClose).toBe(SHUTDOWN_BUDGET_MS.poolWork);
    expect(DERIVED_BUDGETS_MS.releaseJobs).toBe(SHUTDOWN_BUDGET_MS.poolWork + SHUTDOWN_BUDGET_MS.poolHookOverhead);
    expect(DERIVED_BUDGETS_MS.httpStopAccepting).toBe(SHUTDOWN_BUDGET_MS.drainPropagation + SHUTDOWN_BUDGET_MS.httpDrain + SHUTDOWN_BUDGET_MS.httpSweepMargin);
  });

  it('the default numbers: the save phase keeps its whole 45 s, the others add up to 12 s, the backstop is 59 s, the grace period 64 s', () => {
    expect(shutdownPhaseSumMs(45_000)).toBe(45_000 + 2000 + 5000 + 2000 + 1000 + 2000);
    expect(shutdownPhaseSumMs(45_000)).toBe(57_000);
    expect(overallShutdownDeadlineMs(45_000)).toBe(59_000);
    expect(requiredGracePeriodMs(45_000)).toBe(64_000);
  });

  it('sum of the phase deadlines <= backstop <= required grace period, for every save deadline the loader accepts (1 ms to its maximum)', () => {
    for (const save of [1, 1000, 45_000, 600_000, 2_147_483_647]) {
      expect(shutdownPhaseSumMs(save), `save ${String(save)}`).toBeLessThanOrEqual(overallShutdownDeadlineMs(save));
      expect(overallShutdownDeadlineMs(save), `save ${String(save)}`).toBeLessThan(requiredGracePeriodMs(save));
    }
  });

  it('the job queue\'s stop grace is capped at what the release-jobs phase has left, so shutdown never waits on jobs longer than its budget (a hung database included)', () => {
    expect(JOBS_STOP_GRACE_MAX_MS).toBe(1500);
    expect(JOBS_STOP_GRACE_MAX_MS + SHUTDOWN_BUDGET_MS.jobsHookOverhead).toBeLessThanOrEqual(DERIVED_BUDGETS_MS.releaseJobs);
    const env = { GRIMOIRE_LOCAL: '1', GRIMOIRE_DEV_TOKEN_SECRET: 'x'.repeat(40), GRIMOIRE_DATABASE_URL: placeholderDatabaseUrl(), GRIMOIRE_ALLOWED_ORIGINS: 'http://127.0.0.1:8080' };
    expect(loadConfig(env).jobs.stopGraceMs).toBe(JOBS_STOP_GRACE_MAX_MS);
    expect(loadConfig({ ...env, GRIMOIRE_JOBS_STOP_GRACE_MS: String(JOBS_STOP_GRACE_MAX_MS) }).jobs.stopGraceMs).toBe(JOBS_STOP_GRACE_MAX_MS);
    expect(() => loadConfig({ ...env, GRIMOIRE_JOBS_STOP_GRACE_MS: String(JOBS_STOP_GRACE_MAX_MS + 1) })).toThrow(/GRIMOIRE_JOBS_STOP_GRACE_MS/);
  });
});
