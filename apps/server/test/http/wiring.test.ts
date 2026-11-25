import { readdirSync, readFileSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compose } from '../../src/composition.js';
import type { AppContext } from '../../src/composition.js';
import type { HttpDeps } from '../../src/http/env.js';
import { makeContext } from '../server/support/context.js';
import { placeholderDatabaseUrl } from '@tektum/grimoire-core/testing/database-url';

const HTTP_KEYS = [
  'config', 'providerBaseUrl', 'log', 'clock', 'users', 'access', 'authorizer', 'provisioner', 'ordering', 'converter', 'search', 'imports', 'enqueueImport', 'enqueueImportCleanup',
  'idempotency', 'collections', 'audit', 'pages', 'trash', 'revisions', 'admin', 'pageState', 'attachments', 'deleteFiles',
] as const satisfies readonly (keyof HttpDeps)[];

const base = {
  GRIMOIRE_DATABASE_URL: `postgresql://grimoire_app:${randomBytes(12).toString('hex')}@127.0.0.1:1/grimoire`,
  GRIMOIRE_DATABASE_OPS_URL: placeholderDatabaseUrl('127.0.0.1:1'),
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
  it('builds the collaboration host\'s revision repository on the page-store pool, not on the main pool', () => {
    const source = readFileSync(join(__dirname, '../../src/composition.ts'), 'utf8');
    expect(source).toMatch(/revisions: createRevisions\(pageDb, pageOps\)/);
    expect(source).not.toMatch(/revisions: http\.revisions/);
  });

  it.each(['all', 'api', 'collab'])('role %s: ctx.http has every dependency and the collaboration host has a revision repository of its own', (role) => {
    const ctx = ctxOf({ GRIMOIRE_ROLE: role });
    expect(Object.keys(ctx.http).sort()).toEqual([...HTTP_KEYS].sort());
    for (const k of HTTP_KEYS) expect(ctx.http[k], k).toBeDefined();
    expect(ctx.http.config).toBe(ctx.config);
    expect(ctx.http.revisions).toBeDefined();
    // The host's revision work runs on the collab role's own pool: a database that hangs must not leave an idle connection on the main pool to wait out at shutdown.
    if (role !== 'api') {
      expect(ctx.collab?.deps.revisions).toBeDefined();
      expect(ctx.collab?.deps.revisions).not.toBe(ctx.http.revisions);
    }
    expect(ctx.shutdownHooks.map((h) => h.name)).toContain('markdown-pool');
  });

  it.each(['collab', 'api'])('role %s: a job cannot be handed over while there is no queue up (the collab role has none, the api role has not started its own)', async (role) => {
    await expect(ctxOf({ GRIMOIRE_ROLE: role }).http.enqueueImport({ importId: 'i1', tenantId: 't1' })).rejects.toThrow('jobs-unavailable');
  });

  it('role api: the markdown pool is released in release-jobs, before every close-database hook', () => {
    const hooks = ctxOf({ GRIMOIRE_ROLE: 'api' }).shutdownHooks;
    // The jobs of the import are released in the same phase (M7-T00).
    expect(hooks.map((h) => h.name)).toEqual(['markdown-pool', 'embedder', 'jobs', 'database-pool', 'operator-pool']);
    expect(hooks.map((h) => h.phase)).toEqual(['release-jobs', 'release-jobs', 'release-jobs', 'close-database', 'close-database']);
  });

  it('the ordering is the real one: it gives a valid first key and a key between two neighbours', () => {
    const { ordering } = ctxOf().http;
    const first = ordering.between(null, null);
    expect(ordering.isValidPosition(first)).toBe(true);
    const next = ordering.between(first, null);
    const middle = ordering.between(first, next);
    expect(first < middle && middle < next).toBe(true);
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
