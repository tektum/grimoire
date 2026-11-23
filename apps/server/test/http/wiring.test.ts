import { readdirSync, readFileSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compose } from '../../src/composition.js';
import type { AppContext } from '../../src/composition.js';
import type { HttpDeps } from '../../src/http/env.js';
import { makeContext } from '../server/support/context.js';

const HTTP_KEYS = [
  'config', 'log', 'clock', 'users', 'access', 'provisioner', 'ordering', 'converter',
  'idempotency', 'collections', 'audit', 'pages', 'trash', 'revisions', 'admin', 'pageState',
] as const satisfies readonly (keyof HttpDeps)[];

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

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? sources(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('application context wiring', () => {
  it.each(['all', 'api', 'collab'])('role %s: ctx.http has every dependency and the collaboration host shares the revision repository', (role) => {
    const ctx = ctxOf({ GRIMOIRE_ROLE: role });
    expect(Object.keys(ctx.http).sort()).toEqual([...HTTP_KEYS].sort());
    for (const k of HTTP_KEYS) expect(ctx.http[k], k).toBeDefined();
    expect(ctx.http.config).toBe(ctx.config);
    expect(ctx.http.revisions).toBeDefined();
    if (role !== 'api') expect(ctx.collab?.deps.revisions).toBe(ctx.http.revisions);
    expect(ctx.shutdownHooks.map((h) => h.name)).toContain('markdown-pool');
  });

  it('role api: the markdown pool is released in release-jobs, before every close-database hook', () => {
    const hooks = ctxOf({ GRIMOIRE_ROLE: 'api' }).shutdownHooks;
    expect(hooks.map((h) => h.name)).toEqual(['markdown-pool', 'database-pool']);
    expect(hooks.map((h) => h.phase)).toEqual(['release-jobs', 'close-database']);
  });

  it('the ordering fails with OrderingNotAvailable until the ordering task lands', () => {
    expect(() => ctxOf().http.ordering.between(null, null)).toThrow('sibling ordering is not available');
  });

  it('the fake context used by route tests carries the same keys', () => {
    expect(Object.keys(makeContext().ctx.http).sort()).toEqual([...HTTP_KEYS].sort());
  });

  it('only composition.ts constructs repositories', () => {
    const re = /createCollections|createPages\b|createRevisions|createAdmin\b|createTrash|createPageState|createAudit\b|createIdempotency/;
    const hits = sources(join(import.meta.dirname, '../../src')).filter((f) => re.test(readFileSync(f, 'utf8')));
    expect(hits.map((f) => f.split('/').pop())).toEqual(['composition.ts']);
  });
});
