import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createDatabase, createOpsDatabase } from '../../src/index.js';
import type { GrimoireTables, KyselyDatabase, OperatorDatabase } from '../../src/index.js';
import type { CompiledQuery, Kysely, QueryResult } from 'kysely';
import { adminUrl, appUrl, migratorUrl, opsUrl } from '@tektum/grimoire-test-support/database';

const exec = promisify(execFile);
const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const CLI = path.join(ROOT, 'apps/server/dist/cli.js');
const POSTGRES_URL = adminUrl('postgres');

export interface TestDatabase {
  /** The database's name, for a connection as another role. */
  readonly name: string;
  /** The runtime role: what the product connects as. */
  readonly app: KyselyDatabase;
  /** The operator role, for the statements that cross tenants (docs/tenancy.md section 3.2). */
  readonly ops: OperatorDatabase;
  /** The owner of the schema, for facts the runtime role may not read or write. */
  readonly admin: KyselyDatabase;
  drop(): Promise<void>;
}

async function runSql(url: string, sql: string): Promise<void> {
  const postgres = createDatabase(url, { maxConnections: 1 });
  try { await postgres.query(sql); } finally { await postgres.close(); }
}

/** A migrated database of this process only (its own name), dropped by `drop`; never somebody else's runtime database. */
export async function createTestDatabase(label: string): Promise<TestDatabase> {
  const name = `grimoire_m4t05_${label}_${String(process.pid)}`;
  const migrator = migratorUrl(name);
  await runSql(POSTGRES_URL, `drop database if exists ${name} with (force)`);
  await runSql(POSTGRES_URL, `create database ${name} owner grimoire_migrator`);
  await exec(process.execPath, [CLI, 'migrate'], { env: { ...process.env, GRIMOIRE_DATABASE_MIGRATION_URL: migrator } });
  const app = createDatabase(appUrl(name), { maxConnections: 10 });
  const ops = createOpsDatabase(opsUrl(name));
  const admin = createDatabase(migrator, { maxConnections: 2 });
  return {
    name, app, ops, admin,
    async drop() {
      await app.close();
      await ops.close();
      await admin.close();
      await runSql(POSTGRES_URL, `drop database if exists ${name} with (force)`);
    },
  };
}

/** A user row; returns its id. */
export async function addUser(db: KyselyDatabase, name: string, role: 'admin' | 'member' | 'viewer' = 'member', tenantId = 'legacy'): Promise<string> {
  const rows = await db.query<{ id: string }>(
    `insert into users (descope_user_id, email, name, role, tenant_id) values ($1, $2, $1, $3, $4) returning id`,
    [name, `${name}@example.com`, role, tenantId],
  );
  return (rows[0] as { id: string }).id;
}

/** A group row; returns its id. */
export async function addGroup(db: KyselyDatabase, name: string, tenantId = 'legacy'): Promise<string> {
  const rows = await db.query<{ id: string }>(`insert into groups (name, tenant_id) values ($1, $2) returning id`, [name, tenantId]);
  return (rows[0] as { id: string }).id;
}

/** A tenant row (the runtime role may add them, as a first sign-in does). */
export async function addTenant(db: KyselyDatabase, id: string): Promise<void> {
  await db.query(`insert into tenants (id, name, domain) values ($1, $1, $1) on conflict do nothing`, [id]);
}

/** `d` with every statement of the connections `scoped(d, tenant)` takes passed to `around`, which runs it (or not) with `run`. Its own `query` and `transaction` are unchanged. */
export function aroundScoped(d: KyselyDatabase, around: (sql: string, run: () => Promise<QueryResult<unknown>>, params: readonly unknown[]) => Promise<QueryResult<unknown>>): KyselyDatabase {
  const wrap = (one: Kysely<GrimoireTables>) => new Proxy(one, {
    get: (k, p) => (p === 'executeQuery' ? (q: CompiledQuery) => around(q.sql, () => k.executeQuery(q), q.parameters) : Reflect.get(k, p)) as unknown,
  });
  const connection = () => ({ execute: <T>(fn: (one: Kysely<GrimoireTables>) => Promise<T>) => d.kysely.connection().execute((one) => fn(wrap(one))) });
  return { ...d, kysely: new Proxy(d.kysely, { get: (k, p) => (p === 'connection' ? connection : Reflect.get(k, p)) as unknown }) };
}
