import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { makeFakeConfig } from '@tektum/grimoire-core/testing/fake-config';
import { compose } from '../../src/composition.js';
import { composeMigrate } from '../../src/lifecycle/compose-migrate.js';
import { createRun } from '../../src/lifecycle/run.js';
import { Shutdown } from '../../src/lifecycle/shutdown.js';
import { makeContext } from '../server/support/context.js';
import { placeholderDatabaseUrl } from '@tektum/grimoire-core/testing/database-url';

const base = { GRIMOIRE_LOCAL: '1', GRIMOIRE_DEV_TOKEN_SECRET: 'test-secret-0123456789abcdef', GRIMOIRE_DATABASE_URL: placeholderDatabaseUrl(), GRIMOIRE_ALLOWED_ORIGINS: 'http://127.0.0.1:8080' };

describe('the single composition root (S1/S7)', () => {
  it('only composition imports adapter implementations', () => {
    const hits = execFileSync('grep', ['-rln', "from '@tektum/grimoire-adapter", 'apps/server/src'], { encoding: 'utf8' }).trim().split('\n');
    expect(hits).toEqual(['apps/server/src/composition.ts']);
  });

  it('composing twice self-registers no shutdown hooks: only run.ts performs registration', async () => {
    const register = vi.spyOn(Shutdown.prototype, 'register');
    const first = compose(base);
    const second = compose(base);
    expect(register).not.toHaveBeenCalled(); // composing has no effect on any shutdown controller, global or its own
    register.mockRestore();
    expect(first.ok && second.ok).toBe(true);
    expect(first.ok && first.ctx.shutdownHooks.map((hook) => hook.name)).toEqual(expect.arrayContaining(['database-pool']));
    if (first.ok) {
      for (const hook of first.ctx.shutdownHooks) await hook.run();
    }
    if (second.ok) {
      for (const hook of second.ctx.shutdownHooks) await hook.run();
    }
  });

  it('composition returns every database/conversion hook for run.ts', () => {
    const result = compose(base);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ctx.shutdownHooks.map((hook) => hook.name)).toEqual(['markdown-pool', 'jobs', 'page-store-pool', 'auth-pool', 'database-pool']);
      expect(result.ctx.shutdown.isDraining()).toBe(false);
    }
  });

  it('the CLI receives a migration composition instead of constructing adapters', () => {
    const result = composeMigrate({ env: { GRIMOIRE_DATABASE_MIGRATION_URL: placeholderDatabaseUrl() } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.ctx.config.database.migrationUrl).toContain('postgresql:');
  });

  it('run.ts registers every hook the composition returns, once each and in order, and nothing before it runs', async () => {
    const { ctx, shutdown } = makeContext();
    const ran: string[] = [];
    const hook = (name: string, phase: 'stop-timers' | 'close-database') => ({ name, phase, deadlineMs: 1000, run: () => { ran.push(name); return Promise.resolve(); } });
    const composed = { ok: true as const, ctx: { ...ctx, config: makeFakeConfig({ host: '127.0.0.1', port: 0 }), shutdownHooks: [hook('first', 'stop-timers'), hook('second', 'close-database')] } };
    await shutdown.run(ctx.log, 'SIGTERM'); // nothing is registered yet: composing registered nothing
    expect(ran).toEqual([]);
    const fresh = new Shutdown(ctx.clock);
    await createRun({ compose: () => ({ ...composed, ctx: { ...composed.ctx, shutdown: fresh } }), source: { onSignal: () => undefined, onFault: () => undefined }, exit: () => undefined })();
    await fresh.run(ctx.log, 'SIGTERM');
    expect(ran).toEqual(['first', 'second']);
  });
});
