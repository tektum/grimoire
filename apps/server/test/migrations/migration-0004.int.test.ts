// The raw `insert into pages` statements below stay as written: this test runs before the migration that drops the column defaults, and checks what those defaults did.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createDatabase } from '@tektum/grimoire-adapter-db-kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  appUrl, createTestDatabase, dropTestDatabase, eventually, get, migratorUrl, repoRoot, requireBuild, runToEnd, serverDir, sqlAdmin, startServer,
} from '../server/support/harness.js';

// Each `migrate` below starts the migrator as a process, and runs migrations and pg-boss's own, two or three times in one case: that takes longer than vitest's 5 s default on a loaded runner (in CI, the 0007 and 0008 tests of this family timed out at 5.0 s on a busy one).
vi.setConfig({ testTimeout: 120_000 });

const EMPTY = 'grimoire_m3t03_mig_empty';
const AT_0002 = 'grimoire_m3t03_mig_0002';
const AT_0003 = 'grimoire_m3t03_mig_0003';
const upTo0002 = path.join(repoRoot, 'test-results', 'm3t03-migrations-0002');
const upTo0003 = path.join(repoRoot, 'test-results', 'm3t03-migrations-0003');
// 0005 and 0006 change `pages` (positions, search columns); this file asserts what 0004 did, so it stops there. The whole chain is tested in m4/0005.int.test.ts.
const upTo0004 = path.join(repoRoot, 'test-results', 'm3t03-migrations-0004');
const SYSTEM = '00000000-0000-4000-8000-000000000001';
const UNFILED = '00000000-0000-4000-8000-000000000002';
const ROWS = ['a1111111-3c1d-4a53-9a62-5d1c2a7e8f10', 'a2222222-3c1d-4a53-9a62-5d1c2a7e8f10', 'a3333333-3c1d-4a53-9a62-5d1c2a7e8f10'];
const RANDOM_USER = 'd4444444-3c1d-4a53-9a62-5d1c2a7e8f10';
const TABLES = ['users', 'groups', 'group_members', 'collections', 'collection_access', 'pages'];

const migrate = (db: string, dir?: string) => runToEnd([path.join(serverDir, 'dist/cli.js'), 'migrate', ...(dir ? ['--dir', dir] : [])], { GRIMOIRE_DATABASE_MIGRATION_URL: migratorUrl(db) });
const migrationCount = async (db: string) => Number((await sqlAdmin<{ n: string }>(db, 'select count(*) as n from kysely_migration'))[0]?.n);

function copyMigrations(dir: string, names: string[]): void {
  mkdirSync(dir, { recursive: true });
  for (const n of names) cpSync(path.join(repoRoot, 'db/migrations', n), path.join(dir, n));
}

beforeAll(async () => {
  requireBuild();
  copyMigrations(upTo0002, ['0001_pages.ts', '0002_page_markdown.ts']);
  copyMigrations(upTo0003, ['0001_pages.ts', '0002_page_markdown.ts', '0003_schema_version.ts']);
  copyMigrations(upTo0004, ['0001_pages.ts', '0002_page_markdown.ts', '0003_schema_version.ts', '0004_permissions.ts']);
  for (const db of [EMPTY, AT_0002, AT_0003]) await createTestDatabase(db, false);
}, 60_000);
afterAll(async () => {
  rmSync(upTo0002, { recursive: true, force: true });
  rmSync(upTo0003, { recursive: true, force: true });
  rmSync(upTo0004, { recursive: true, force: true });
  for (const db of [EMPTY, AT_0002, AT_0003]) await dropTestDatabase(db);
});

describe('migration 0004 (permissions)', () => {
  it('on a database at 0002 with three bare page rows it keeps the rows and fills the new columns', async () => {
    expect((await migrate(AT_0002, upTo0002)).code).toBe(0);
    await sqlAdmin(AT_0002, `insert into pages (id, markdown_hash, last_edited_by) values ('${ROWS[0]}', decode(repeat('ab', 32), 'hex'), '${RANDOM_USER}'), ('${ROWS[1]}', null, null), ('${ROWS[2]}', decode(repeat('cd', 32), 'hex'), null)`);
    expect((await migrate(AT_0002, upTo0004)).code).toBe(0);
    const rows = await sqlAdmin<{ id: string; url_id: string; collection_id: string; created_by: string; position: string; last_edited_by: string | null; markdown_hash: Buffer | null; title: string; deleted_at: Date | null }>(
      AT_0002, 'select id, url_id, collection_id, created_by, position, last_edited_by, markdown_hash, title, deleted_at from pages order by id');
    expect(rows.map((r) => r.id)).toEqual(ROWS);
    for (const r of rows) {
      expect(r.url_id).toMatch(/^[0-9A-Za-z]{10}$/);
      expect(r).toMatchObject({ collection_id: UNFILED, created_by: SYSTEM, position: 'a0', last_edited_by: null, markdown_hash: null, title: '', deleted_at: null });
    }
    expect(new Set(rows.map((r) => r.url_id)).size).toBe(3);
  });

  it('creates the system user (suspended viewer) and the private "Unfiled" collection', async () => {
    expect(await sqlAdmin(AT_0002, `select descope_user_id, email::text as email, role, suspended_at is not null as suspended from users where id = '${SYSTEM}'`)).toEqual([
      { descope_user_id: 'system:migration', email: 'system@grimoire.invalid', role: 'viewer', suspended: true },
    ]);
    expect(await sqlAdmin(AT_0002, `select name, default_permission, created_by from collections where id = '${UNFILED}'`)).toEqual([{ name: 'Unfiled', default_permission: null, created_by: SYSTEM }]);
  });

  it('a second run is a no-op', async () => {
    const before = await migrationCount(AT_0002);
    const again = await migrate(AT_0002, upTo0004);
    expect(again.code).toBe(0);
    expect(again.output).toContain('migrate.nothing_pending');
    expect(await migrationCount(AT_0002)).toBe(before);
    expect(Number((await sqlAdmin<{ n: string }>(AT_0002, 'select count(*) as n from users'))[0]?.n)).toBe(1);
  });

  it('on an empty database the chain up to 0004 applies', async () => {
    expect((await migrate(EMPTY, upTo0004)).code).toBe(0);
    expect(await sqlAdmin(EMPTY, "select name from kysely_migration order by name desc limit 1")).toEqual([{ name: '0004_permissions' }]);
    const tables = await sqlAdmin<{ table_name: string }>(EMPTY, "select table_name from information_schema.tables where table_schema = 'public'");
    expect(tables.map((t) => t.table_name)).toEqual(expect.arrayContaining(TABLES));
  });

  it('the runtime role can select, insert, update and delete on the six tables, cannot create tables or truncate, and has no right on the migration tables', async () => {
    const app = createDatabase(appUrl(EMPTY), { maxConnections: 1 });
    try {
      for (const t of TABLES) {
        for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) expect(await app.query(`select has_table_privilege('grimoire_app', '${t}', '${p}') as t`)).toEqual([{ t: true }]);
        for (const p of ['TRUNCATE', 'REFERENCES', 'TRIGGER']) expect(await app.query(`select has_table_privilege('grimoire_app', '${t}', '${p}') as t`)).toEqual([{ t: false }]);
      }
      for (const t of ['kysely_migration', 'kysely_migration_lock']) {
        for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
          expect(await app.query(`select has_table_privilege('grimoire_app', '${t}', '${p}') as t`), `${t} ${p}`).toEqual([{ t: false }]);
        }
      }
      await expect(app.query('create table x()')).rejects.toMatchObject({ code: '42501' });
      expect(await app.query("select 'A'::citext = 'a' as t")).toEqual([{ t: true }]);
      await app.query("insert into groups (name) values ('G')");
      await app.query("update groups set name = 'H' where name = 'G'");
      await app.query("delete from groups where name = 'H'");
      // Only id and a null Markdown are given: collection_id, created_by and position come from the column defaults.
      await app.query("insert into pages (id, markdown) values ('b1111111-3c1d-4a53-9a62-5d1c2a7e8f10', null)");
      expect(await app.query("select collection_id, created_by, position from pages where id = 'b1111111-3c1d-4a53-9a62-5d1c2a7e8f10'")).toEqual([{ collection_id: UNFILED, created_by: SYSTEM, position: 'a0' }]);
      expect(await app.query("select grimoire_url_id() ~ '^[0-9A-Za-z]{10}$' as t")).toEqual([{ t: true }]);
    } finally {
      await app.close();
    }
  });

  describe('constraints', () => {
    const U1 = 'e1000000-3c1d-4a53-9a62-5d1c2a7e8f10';
    const C1 = 'c1000000-3c1d-4a53-9a62-5d1c2a7e8f10';
    const C2 = 'c2000000-3c1d-4a53-9a62-5d1c2a7e8f10';
    const G1 = 'f1000000-3c1d-4a53-9a62-5d1c2a7e8f10';
    const P = (n: number) => `a000000${String(n)}-3c1d-4a53-9a62-5d1c2a7e8f10`;
    const admin = (sql: string) => sqlAdmin(EMPTY, sql);

    beforeAll(async () => {
      await admin(`insert into users (id, descope_user_id, email, name) values ('${U1}', 'u1', 'Ann@Example.com', 'Ann')`);
      await admin(`insert into groups (id, name) values ('${G1}', 'Eng')`);
      await admin(`insert into collections (id, name, position, created_by) values ('${C1}', 'One', 'a0', '${U1}'), ('${C2}', 'Two', 'a1', '${U1}')`);
    });

    it('a page whose parent is in another collection fails at commit', async () => {
      await admin(`insert into pages (id, collection_id) values ('${P(1)}', '${C1}')`);
      await expect(admin(`insert into pages (id, collection_id, parent_id) values ('${P(2)}', '${C2}', '${P(1)}')`)).rejects.toMatchObject({ code: '23503' });
      await admin(`insert into pages (id, collection_id, parent_id) values ('${P(3)}', '${C1}', '${P(1)}')`);
    });

    it('moving a subtree to another collection in one statement succeeds (deferred constraint)', async () => {
      await admin(`update pages set collection_id = '${C2}' where id in ('${P(1)}', '${P(3)}')`);
      expect(await admin(`select collection_id from pages where id = '${P(3)}'`)).toEqual([{ collection_id: C2 }]);
    });

    it('a collection_access row needs exactly one of user_id and group_id', async () => {
      await expect(admin(`insert into collection_access (collection_id, user_id, group_id, permission) values ('${C1}', '${U1}', '${G1}', 'read')`)).rejects.toMatchObject({ code: '23514' });
      await expect(admin(`insert into collection_access (collection_id, permission) values ('${C1}', 'read')`)).rejects.toMatchObject({ code: '23514' });
    });

    it('the two partial unique indexes reject duplicates', async () => {
      await admin(`insert into collection_access (collection_id, user_id, permission) values ('${C1}', '${U1}', 'read')`);
      await expect(admin(`insert into collection_access (collection_id, user_id, permission) values ('${C1}', '${U1}', 'read_write')`)).rejects.toMatchObject({ code: '23505' });
      await admin(`insert into collection_access (collection_id, group_id, permission) values ('${C1}', '${G1}', 'read')`);
      await expect(admin(`insert into collection_access (collection_id, group_id, permission) values ('${C1}', '${G1}', 'read')`)).rejects.toMatchObject({ code: '23505' });
    });

    it('users.email is unique ignoring case', async () => {
      await expect(admin("insert into users (descope_user_id, email, name) values ('u2', 'ann@example.com', 'Dup')")).rejects.toMatchObject({ code: '23505' });
    });

    it('a role outside the three values fails', async () => {
      await expect(admin("insert into users (descope_user_id, email, name, role) values ('u3', 'x@example.com', 'X', 'owner')")).rejects.toMatchObject({ code: '23514' });
    });

    it('a page with a last_edited_by that is not a user fails', async () => {
      await expect(admin(`insert into pages (id, last_edited_by) values ('${P(4)}', '${RANDOM_USER}')`)).rejects.toMatchObject({ code: '23503' });
    });

    it('a page title longer than 255 characters fails', async () => {
      await expect(admin(`insert into pages (id, title) values ('${P(5)}', repeat('x', 256))`)).rejects.toMatchObject({ code: '23514' });
    });
  });

  it('/readyz is 503 while 0004 is pending and 200 once it is applied', async () => {
    expect((await migrate(AT_0003, upTo0003)).code).toBe(0);
    const s = await startServer({ env: { GRIMOIRE_DATABASE_URL: appUrl(AT_0003) } });
    try {
      const url = `http://127.0.0.1:${s.port}/readyz`;
      await eventually(async () => ((await get(url)).status === 503 ? true : undefined), 4000, '/readyz 503 with only 0003 applied');
      expect((await migrate(AT_0003)).code).toBe(0);
      await eventually(async () => ((await get(url)).status === 200 ? true : undefined), 4000, '/readyz 200 once 0004 is applied');
    } finally {
      await s.kill();
    }
  }, 60_000);
});
