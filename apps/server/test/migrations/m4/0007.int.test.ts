import { cpSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createDatabase } from '@tektum/grimoire-adapter-db-kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { appUrl, createTestDatabase, dropTestDatabase, migratorUrl, repoRoot, requireBuild, runToEnd, serverDir, sqlAdmin } from '../../server/support/harness.js';

// Each `migrate` below starts the migrator as a process, and runs migrations and pg-boss's own, two or three times in one case: that takes longer than vitest's 5 s default on a loaded runner (in CI, the 0007 and 0008 tests of this family timed out at 5.0 s on a busy one).
vi.setConfig({ testTimeout: 120_000 });

// Migration 0007 (the age index of `idempotency_keys`) on a database at 0006 that already holds keys.
const AT_0006 = 'grimoire_m4t02_mig_0006';
const upTo0006 = path.join(repoRoot, 'test-results', 'm4t02-migrations-0006');
const USER = 'b0000000-3c1d-4a53-9a62-5d1c2a7e8f10';

const migrate = (db: string, dir?: string) => runToEnd([path.join(serverDir, 'dist/cli.js'), 'migrate', ...(dir ? ['--dir', dir] : [])], { GRIMOIRE_DATABASE_MIGRATION_URL: migratorUrl(db) });

beforeAll(async () => {
  requireBuild();
  mkdirSync(upTo0006, { recursive: true });
  for (const name of ['0001_pages.ts', '0002_page_markdown.ts', '0003_schema_version.ts', '0004_permissions.ts', '0005_history_files_imports_audit.ts', '0006_page_search_and_positions.ts']) {
    cpSync(path.join(repoRoot, 'db/migrations', name), path.join(upTo0006, name));
  }
  await createTestDatabase(AT_0006, false);
}, 60_000);
afterAll(async () => {
  rmSync(upTo0006, { recursive: true, force: true });
  await dropTestDatabase(AT_0006);
});

describe('migration 0007', () => {
  it('adds the age index to a database that holds keys, keeps the keys and the grants of 0005, and a second run applies nothing', async () => {
    expect((await migrate(AT_0006, upTo0006)).code).toBe(0);
    await sqlAdmin(AT_0006, `insert into idempotency_keys (user_id, key, request_hash, status, response) values ('${USER}', 'k', '\\x00', 201, '{"id":"p1"}')`);
    expect(await sqlAdmin(AT_0006, `select count(*)::int as n from pg_indexes where indexname = 'idempotency_keys_created_idx'`)).toEqual([{ n: 0 }]);

    const run = await migrate(AT_0006);
    expect(run.code, run.output).toBe(0);
    const [index] = await sqlAdmin<{ indexdef: string }>(AT_0006, `select indexdef from pg_indexes where indexname = 'idempotency_keys_created_idx'`);
    expect(index?.indexdef).toMatch(/^CREATE INDEX idempotency_keys_created_idx ON .*idempotency_keys USING btree \(created_at\)$/);
    expect(await sqlAdmin(AT_0006, 'select count(*)::int as n from idempotency_keys')).toEqual([{ n: 1 }]);

    const app = createDatabase(appUrl(AT_0006), { maxConnections: 1 });
    try {
      await app.query("select set_config('app.tenant', 'legacy', false)"); // row-level security: the runtime role sees the rows of its tenant (one connection, so the setting stays)
      expect(await app.query(`select key from idempotency_keys where user_id = '${USER}'`)).toEqual([{ key: 'k' }]);
      await app.query(`delete from idempotency_keys where created_at < now() + interval '1 hour'`);
      expect(await app.query('select 1 from idempotency_keys')).toEqual([]);
    } finally {
      await app.close();
    }
    const again = await migrate(AT_0006);
    expect(again.code, again.output).toBe(0);
    expect(again.output).toContain('migrate.nothing_pending');
  });
});
