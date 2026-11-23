// The raw `insert into pages` statements below stay as written: they run against the schema as of migrations 0001 and 0002, before pages have a collection or an author.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createDatabase } from '@tektum/grimoire-adapter-db-kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appUrl, createTestDatabase, dropTestDatabase, migratorUrl, repoRoot, requireBuild, runToEnd, serverDir, sqlAdmin } from '../server/support/harness.js';

const EMPTY = 'grimoire_m2t04_mig_empty';
const AT_0001 = 'grimoire_m2t04_mig_0001';
const only0001 = path.join(repoRoot, 'test-results', 'm2t04-migrations-0001');
const NEW_COLUMNS = ['markdown', 'text_content', 'markdown_hash', 'last_edited_by', 'last_edited_at'];

const migrate = (db: string, dir?: string) => runToEnd([path.join(serverDir, 'dist/cli.js'), 'migrate', ...(dir ? ['--dir', dir] : [])], { GRIMOIRE_DATABASE_MIGRATION_URL: migratorUrl(db) });
const columns = async (db: string): Promise<string[]> => (await sqlAdmin<{ column_name: string }>(db, "select column_name from information_schema.columns where table_name = 'pages'")).map((r) => r.column_name);

beforeAll(async () => {
  requireBuild();
  mkdirSync(only0001, { recursive: true });
  cpSync(path.join(repoRoot, 'db/migrations/0001_pages.ts'), path.join(only0001, '0001_pages.ts'));
  await createTestDatabase(EMPTY, false);
  await createTestDatabase(AT_0001, false);
}, 60_000);
afterAll(async () => {
  rmSync(only0001, { recursive: true, force: true });
  await dropTestDatabase(EMPTY);
  await dropTestDatabase(AT_0001);
});

describe('migration 0002 (page markdown)', () => {
  it('on an empty database `grimoire migrate` gives pages the five new columns', async () => {
    expect((await migrate(EMPTY)).code).toBe(0);
    expect(await columns(EMPTY)).toEqual(expect.arrayContaining(NEW_COLUMNS));
  });

  it('on a database at version 0001 it adds the columns and keeps the rows', async () => {
    expect((await migrate(AT_0001, only0001)).code).toBe(0);
    expect(await columns(AT_0001)).not.toContain('markdown');
    await sqlAdmin(AT_0001, "insert into pages (id, ydoc) values ('0b6f4f0e-3c1d-4a53-9a62-5d1c2a7e8f10', '\\x0102')");
    expect((await migrate(AT_0001)).code).toBe(0);
    expect(await columns(AT_0001)).toEqual(expect.arrayContaining(NEW_COLUMNS));
    const rows = await sqlAdmin<{ markdown: string | null; markdown_hash: Buffer | null; n: number }>(AT_0001, 'select markdown, markdown_hash, octet_length(ydoc) as n from pages');
    expect(rows).toEqual([{ markdown: null, markdown_hash: null, n: 2 }]);
  });

  it('the runtime role can select, insert, update and delete, cannot create tables (42501) or truncate', async () => {
    const app = createDatabase(appUrl(EMPTY), { maxConnections: 1 });
    try {
      await app.query("insert into pages (id, markdown) values ('1b6f4f0e-3c1d-4a53-9a62-5d1c2a7e8f10', 'x')");
      expect(await app.query("select markdown from pages where id = '1b6f4f0e-3c1d-4a53-9a62-5d1c2a7e8f10'")).toEqual([{ markdown: 'x' }]);
      await app.query("update pages set text_content = 't' where id = '1b6f4f0e-3c1d-4a53-9a62-5d1c2a7e8f10'");
      await app.query("delete from pages where id = '1b6f4f0e-3c1d-4a53-9a62-5d1c2a7e8f10'");
      await expect(app.query('create table x()')).rejects.toMatchObject({ code: '42501' });
      expect(await app.query("select has_table_privilege('grimoire_app', 'pages', 'TRUNCATE') as t")).toEqual([{ t: false }]);
      for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        expect(await app.query(`select has_table_privilege('grimoire_app', 'pages', '${p}') as t`)).toEqual([{ t: true }]);
      }
    } finally {
      await app.close();
    }
  });

  it('a markdown_hash of 31 bytes is rejected, one of 32 bytes is accepted', async () => {
    await expect(sqlAdmin(EMPTY, "insert into pages (markdown_hash) values (decode(repeat('ab', 31), 'hex'))")).rejects.toMatchObject({ code: '23514' });
    await sqlAdmin(EMPTY, "insert into pages (markdown_hash) values (decode(repeat('ab', 32), 'hex'))");
  });
});
