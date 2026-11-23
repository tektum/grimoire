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
