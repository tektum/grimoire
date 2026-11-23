import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createDatabase } from '../../src/index.js';
import type { KyselyDatabase } from '../../src/index.js';

const exec = promisify(execFile);
const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const CLI = path.join(ROOT, 'apps/server/dist/cli.js');
const POSTGRES_URL = 'postgresql://grimoire_admin:grimoire-dev@127.0.0.1:55432/postgres';

export interface TestDatabase {
  /** The runtime role: what the product connects as. */
  readonly app: KyselyDatabase;
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
  const migrator = `postgresql://grimoire_migrator:grimoire-dev@127.0.0.1:55432/${name}`;
  await runSql(POSTGRES_URL, `drop database if exists ${name} with (force)`);
  await runSql(POSTGRES_URL, `create database ${name} owner grimoire_migrator`);
  await exec(process.execPath, [CLI, 'migrate'], { env: { ...process.env, GRIMOIRE_DATABASE_MIGRATION_URL: migrator } });
  const app = createDatabase(`postgresql://grimoire_app:grimoire-dev@127.0.0.1:55432/${name}`, { maxConnections: 10 });
  const admin = createDatabase(migrator, { maxConnections: 2 });
  return {
    app, admin,
    async drop() {
      await app.close();
      await admin.close();
      await runSql(POSTGRES_URL, `drop database if exists ${name} with (force)`);
    },
  };
}

/** A user row; returns its id. */
export async function addUser(db: KyselyDatabase, name: string, role: 'admin' | 'member' | 'viewer' = 'member'): Promise<string> {
  const rows = await db.query<{ id: string }>(
    `insert into users (descope_user_id, email, name, role) values ($1, $2, $1, $3) returning id`,
    [name, `${name}@example.com`, role],
  );
  return (rows[0] as { id: string }).id;
}
