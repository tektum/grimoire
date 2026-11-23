import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runToEnd } from '@tektum/grimoire-test-support';
import { createDatabase } from '../src/index.js';
import type { KyselyDatabase } from '../src/index.js';
import { declaredColumns } from '../src/schema.js';

// Its own database, created and dropped by this file, never somebody else's.
const DATABASE = `grimoire_m4t00_schema_${String(process.pid)}`;
const server = '127.0.0.1:55432';
const url = (role: string, name: string): string => `postgresql://${role}:grimoire-dev@${server}/${name}`;
const CLI = path.join(fileURLToPath(new URL('../../../../', import.meta.url)), 'apps/server/dist/cli.js');
let db: KyselyDatabase;

async function runSql(connection: string, text: string): Promise<void> {
  const handle = createDatabase(connection, { maxConnections: 1 });
  try { await handle.query(text); } finally { await handle.close(); }
}

beforeAll(async () => {
  await runSql(url('grimoire_admin', 'postgres'), `drop database if exists ${DATABASE} with (force)`);
  await runSql(url('grimoire_admin', 'postgres'), `create database ${DATABASE} owner grimoire_migrator`);
  const migrated = await runToEnd([CLI, 'migrate'], { GRIMOIRE_DATABASE_MIGRATION_URL: url('grimoire_migrator', DATABASE) });
  expect(migrated.code, migrated.output).toBe(0);
  db = createDatabase(url('grimoire_migrator', DATABASE), { maxConnections: 2 });
}, 60_000);
afterAll(async () => {
  await db?.close();
  await runSql(url('grimoire_admin', 'postgres'), `drop database if exists ${DATABASE} with (force)`);
});

interface Column { table_name: string; column_name: string; is_nullable: 'YES' | 'NO' }

describe('declared tables match the migrated database', () => {
  it('declares every column of every declared table with the right nullability, and nothing is left undeclared', async () => {
    const rows = await db.query<Column>(
      `select table_name, column_name, is_nullable from information_schema.columns where table_schema = 'public' and table_name = any($1) order by 1, 2`,
      [Object.keys(declaredColumns)],
    );
    const actual: Record<string, Record<string, 'nullable' | 'required'>> = {};
    for (const row of rows) (actual[row.table_name] ??= {})[row.column_name] = row.is_nullable === 'YES' ? 'nullable' : 'required';
    const sorted = (value: Record<string, Record<string, string>>): Record<string, [string, string][]> =>
      Object.fromEntries(Object.entries(value).map(([table, columns]) => [table, Object.entries(columns).sort(([a], [b]) => a.localeCompare(b))]));
    expect(sorted(actual)).toEqual(sorted(declaredColumns));
  });
});

describe('migration 0005 tables: grants of the runtime role', () => {
  const privileges = async (table: string): Promise<string[]> => {
    const rows = await db.query<{ privilege: string; granted: boolean }>(
      `select p as privilege, has_table_privilege('grimoire_app', $1, p) as granted
         from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) as p`,
      [table],
    );
    return rows.filter((r) => r.granted).map((r) => r.privilege);
  };

  it.each([
    ['revisions', ['SELECT', 'INSERT']],
    ['audit_events', ['SELECT', 'INSERT']],
    ['attachments', ['SELECT', 'INSERT', 'UPDATE', 'DELETE']],
    ['idempotency_keys', ['SELECT', 'INSERT', 'UPDATE', 'DELETE']],
    ['imports', ['SELECT', 'INSERT', 'UPDATE']],
    ['import_items', ['SELECT', 'INSERT', 'UPDATE']],
  ])('%s grants exactly %j', async (table, expected) => {
    expect((await privileges(table)).sort()).toEqual([...expected].sort());
  });

  it('grants usage and select on the two new sequences', async () => {
    for (const sequence of ['audit_events_id_seq', 'import_items_id_seq']) {
      const [row] = await db.query<{ usage: boolean; sel: boolean; upd: boolean }>(
        `select has_sequence_privilege('grimoire_app', $1, 'USAGE') as usage, has_sequence_privilege('grimoire_app', $1, 'SELECT') as sel,
                has_sequence_privilege('grimoire_app', $1, 'UPDATE') as upd`,
        [sequence],
      );
      expect(row).toEqual({ usage: true, sel: true, upd: false });
    }
  });
});

describe('migration 0005 tables: constraints and delete behaviour', () => {
  const insertPage = async (): Promise<string> => (await db.query<{ id: string }>('insert into pages default values returning id'))[0]!.id;
  const hash = "decode(repeat('ab', 32), 'hex')";

  it('rejects a revision with a short hash or an unknown reason', async () => {
    const page = await insertPage();
    await expect(db.query(`insert into revisions (page_id, title, markdown, markdown_hash, reason, created_at) values ($1, 't', 'm', decode('ab', 'hex'), 'idle', now())`, [page])).rejects.toThrow();
    await expect(db.query(`insert into revisions (page_id, title, markdown, markdown_hash, reason, created_at) values ($1, 't', 'm', ${hash}, 'nope', now())`, [page])).rejects.toThrow();
  });

  it('deletes revisions and attachment rows with their page', async () => {
    const page = await insertPage();
    await db.query(`insert into revisions (page_id, title, markdown, markdown_hash, reason, created_at) values ($1, 't', 'm', ${hash}, 'manual', now())`, [page]);
    await db.query(`insert into attachments (page_id, file_name, content_type, size, s3_key, status) values ($1, 'a.png', 'image/png', 1, 'k', 'pending')`, [page]);
    await db.query('delete from pages where id = $1', [page]);
    expect(await db.query('select 1 from revisions where page_id = $1', [page])).toEqual([]);
    expect(await db.query('select 1 from attachments where page_id = $1', [page])).toEqual([]);
  });

  it('rejects an attachment of size 0 or an unknown status', async () => {
    const page = await insertPage();
    await expect(db.query(`insert into attachments (page_id, file_name, content_type, size, s3_key, status) values ($1, 'a', 'b', 0, 'k', 'ready')`, [page])).rejects.toThrow();
    await expect(db.query(`insert into attachments (page_id, file_name, content_type, size, s3_key, status) values ($1, 'a', 'b', 1, 'k', 'done')`, [page])).rejects.toThrow();
  });

  it('restricts the removal of a collection that an import targets, and cascades import items', async () => {
    const [collection] = await db.query<{ id: string }>(`insert into collections (name, position, created_by) values ('c', 'a1', '00000000-0000-4000-8000-000000000001') returning id`);
    const [imp] = await db.query<{ id: string }>(`insert into imports (target_collection_id, source) values ($1, 'markdown_zip') returning id`, [collection!.id]);
    await db.query(`insert into import_items (import_id, path, kind) values ($1, 'a.md', 'page')`, [imp!.id]);
    await expect(db.query(`insert into import_items (import_id, path, kind) values ($1, 'a.md', 'page')`, [imp!.id])).rejects.toThrow(/unique/);
    await expect(db.query('delete from collections where id = $1', [collection!.id])).rejects.toThrow(/foreign key/);
    await db.query('delete from imports where id = $1', [imp!.id]);
    expect(await db.query('select 1 from import_items where import_id = $1', [imp!.id])).toEqual([]);
  });

  it('keeps audit events without a foreign key on the actor', async () => {
    await db.query(`insert into audit_events (actor_id, action) values (gen_random_uuid(), 'test')`);
  });
});
