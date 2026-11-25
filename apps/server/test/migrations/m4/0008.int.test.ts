import { cpSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, dropTestDatabase, migratorUrl, repoRoot, requireBuild, runToEnd, serverDir, sqlAdmin } from '../../server/support/harness.js';

// Each `migrate` below starts the migrator as a process, and runs migrations and pg-boss's own, two or three times in one case: that takes longer than vitest's 5 s default on a loaded runner (in CI, the 0007 and 0008 tests of this family timed out at 5.0 s on a busy one).
vi.setConfig({ testTimeout: 120_000 });

// Migration 0008 (the page defaults of `collection_id` and `created_by` are dropped) on a database at 0007 that already holds a page.
const AT_0007 = 'grimoire_m4t06_mig_0007';
const upTo0007 = path.join(repoRoot, 'test-results', 'm4t06-migrations-0007');
const USER = 'b0000000-3c1d-4a53-9a62-5d1c2a7e8f10';
const COLLECTION = 'c0000000-3c1d-4a53-9a62-5d1c2a7e8f10';
const OLD_PAGE = 'a0000000-3c1d-4a53-9a62-5d1c2a7e8f10';

const migrate = (db: string, dir?: string) => runToEnd([path.join(serverDir, 'dist/cli.js'), 'migrate', ...(dir ? ['--dir', dir] : [])], { GRIMOIRE_DATABASE_MIGRATION_URL: migratorUrl(db) });

beforeAll(async () => {
  requireBuild();
  mkdirSync(upTo0007, { recursive: true });
  for (const name of ['0001_pages.ts', '0002_page_markdown.ts', '0003_schema_version.ts', '0004_permissions.ts', '0005_history_files_imports_audit.ts', '0006_page_search_and_positions.ts', '0007_idempotency_created_index.ts']) {
    cpSync(path.join(repoRoot, 'db/migrations', name), path.join(upTo0007, name));
  }
  await createTestDatabase(AT_0007, false);
}, 60_000);
afterAll(async () => {
  rmSync(upTo0007, { recursive: true, force: true });
  await dropTestDatabase(AT_0007);
});

describe('migration 0008', () => {
  it('refuses a page insert that names neither column, keeps the page that exists, keeps the url_id and position defaults, and a second run applies nothing', async () => {
    expect((await migrate(AT_0007, upTo0007)).code).toBe(0);
    // At 0007 a bare insert still lands in the unfiled collection as the system user.
    await sqlAdmin(AT_0007, `insert into pages (id) values ('${OLD_PAGE}')`);
    const [before] = await sqlAdmin<{ has: boolean }>(AT_0007, `select (column_default is not null) as has from information_schema.columns where table_name = 'pages' and column_name = 'collection_id'`);
    expect(before?.has).toBe(true);

    const run = await migrate(AT_0007);
    expect(run.code, run.output).toBe(0);
    const defaults = await sqlAdmin<{ column_name: string; has: boolean }>(
      AT_0007,
      `select column_name, (column_default is not null) as has from information_schema.columns where table_name = 'pages' and column_name in ('collection_id', 'created_by', 'url_id', 'position') order by column_name`,
    );
    expect(defaults).toEqual([
      { column_name: 'collection_id', has: false }, { column_name: 'created_by', has: false }, { column_name: 'position', has: true }, { column_name: 'url_id', has: true },
    ]);

    await expect(sqlAdmin(AT_0007, `insert into pages (id) values ('a1111111-3c1d-4a53-9a62-5d1c2a7e8f10')`)).rejects.toThrow(/null value in column/);
    await expect(sqlAdmin(AT_0007, `insert into pages (id, collection_id) values ('a2222222-3c1d-4a53-9a62-5d1c2a7e8f10', '${COLLECTION}')`)).rejects.toThrow();
    await sqlAdmin(AT_0007, `insert into users (id, descope_user_id, email, name) values ('${USER}', 'u1', 'u1@example.com', 'U')`);
    await sqlAdmin(AT_0007, `insert into collections (id, name, position, created_by) values ('${COLLECTION}', 'C', 'a1', '${USER}')`);
    await sqlAdmin(AT_0007, `insert into pages (id, collection_id, created_by) values ('a3333333-3c1d-4a53-9a62-5d1c2a7e8f10', '${COLLECTION}', '${USER}')`);
    const [fresh] = await sqlAdmin<{ url_id: string; position: string }>(AT_0007, `select url_id, position from pages where id = 'a3333333-3c1d-4a53-9a62-5d1c2a7e8f10'`);
    expect(fresh?.url_id).toMatch(/\S+/);
    expect(fresh?.position).toMatch(/\S+/);
    expect(await sqlAdmin(AT_0007, `select count(*)::int as n from pages where id = '${OLD_PAGE}'`)).toEqual([{ n: 1 }]);

    const again = await migrate(AT_0007);
    expect(again.code, again.output).toBe(0);
    expect(again.output).toContain('migrate.nothing_pending');
  });
});
