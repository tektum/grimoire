import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { compose } from '../../src/composition.js';
import type { AppContext } from '../../src/composition.js';

// M7-T00: by role, the composition has the job runner (api and all), or not (collab); the hook that stops the jobs is in the release-jobs phase.
const base = {
  GRIMOIRE_DATABASE_URL: `postgresql://grimoire_app:${randomBytes(12).toString('hex')}@127.0.0.1:1/grimoire`,
  GRIMOIRE_ALLOWED_ORIGINS: 'http://127.0.0.1:8080',
  GRIMOIRE_DEV_TOKEN_SECRET: randomBytes(24).toString('hex'),
  GRIMOIRE_LOCAL: '1',
};
const opened: AppContext[] = [];
afterEach(async () => { for (const c of opened.splice(0)) for (const h of c.shutdownHooks) await h.run(); });
function ctxOf(extra: Record<string, string> = {}): AppContext {
  const c = compose({ ...base, ...extra });
  if (!c.ok) throw new Error(c.issues.join('; '));
  opened.push(c.ctx);
  return c.ctx;
}

describe('the composition by role', () => {
  it.each(['api', 'all'])('role %s has the job runner and its shutdown hook in release-jobs, and no second converter pool (one pool for the process)', (role) => {
    const ctx = ctxOf({ GRIMOIRE_ROLE: role });
    expect(ctx.jobs).toBeDefined();
    expect(ctx.shutdownHooks.filter((h) => h.phase === 'release-jobs').map((h) => h.name)).toEqual(['markdown-pool', 'embedder', 'jobs']);
  });

  it('role collab has neither', () => {
    const ctx = ctxOf({ GRIMOIRE_ROLE: 'collab', GRIMOIRE_COLLAB_PORT: '8081' });
    expect(ctx.jobs).toBeUndefined();
    expect(ctx.shutdownHooks.some((h) => h.name === 'jobs')).toBe(false);
  });

  it('the routes get the search and import repositories', () => {
    const ctx = ctxOf();
    expect(typeof ctx.http.search.search).toBe('function');
    expect(typeof ctx.http.imports.get).toBe('function');
  });
});
