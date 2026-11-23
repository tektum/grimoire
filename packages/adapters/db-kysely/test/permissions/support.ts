import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';
import { insertPage, raw } from '@tektum/grimoire-test-support/database';
import type { Queryable } from '@tektum/grimoire-core/ports/database';
import type { World } from '@tektum/grimoire-core/testing/fake-access-store';

// Dev-only credentials of the Compose database (`make db-up`). Every test file creates and drops its own database.
const SERVER = '127.0.0.1:55432';
const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
export const urlFor = (role: 'grimoire_admin' | 'grimoire_migrator' | 'grimoire_app', db: string): string => `postgresql://${role}:grimoire-dev@${SERVER}/${db}`;

export async function sqlAs<T extends pg.QueryResultRow = pg.QueryResultRow>(url: string, text: string, params: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<T>(text, params)).rows;
  } finally {
    await client.end();
  }
}

/** Builds the repo, creates `db` owned by the migrator and migrates it with the compiled CLI. */
export async function createMigratedDatabase(db: string): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    execFile(process.execPath, [path.join(ROOT, 'node_modules/typescript/bin/tsc'), '-b'], { cwd: ROOT }, (e, o) => (e ? reject(new Error(`tsc -b failed:\n${o}`)) : resolve())));
  await dropDatabase(db);
  await sqlAs(urlFor('grimoire_admin', 'postgres'), `create database ${db} owner grimoire_migrator`);
  const env: NodeJS.ProcessEnv = { ...process.env, GRIMOIRE_DATABASE_MIGRATION_URL: urlFor('grimoire_migrator', db) };
  await new Promise<void>((resolve, reject) =>
    execFile(process.execPath, [path.join(ROOT, 'apps/server/dist/cli.js'), 'migrate'], { env }, (e, o, err) => (e ? reject(new Error(`migrate failed:\n${o}${err}`)) : resolve())));
}
export const dropDatabase = (db: string): Promise<unknown[]> => sqlAs(urlFor('grimoire_admin', 'postgres'), `drop database if exists ${db} with (force)`);

const SYSTEM_USER = '00000000-0000-4000-8000-000000000001';
const UNFILED = '00000000-0000-4000-8000-000000000002';

/** Inserts a world with a few statements (arrays through `unnest`); the database must be one this test created. */
export async function loadWorld(db: string, w: World): Promise<void> {
  const url = urlFor('grimoire_admin', db);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('begin');
    await client.query(
      `insert into users (id, descope_user_id, email, name, role, suspended_at)
         select id, id::text, id::text || '@example.invalid', 'user', role, case when suspended then now() end from unnest($1::uuid[], $2::text[], $3::boolean[]) as t(id, role, suspended)`,
      [w.users.map((u) => u.id), w.users.map((u) => u.role), w.users.map((u) => u.suspended)]);
    await client.query(`insert into groups (id, name) select id, id::text from unnest($1::uuid[]) as t(id)`, [w.groups.map((g) => g.id)]);
    await client.query(`insert into group_members (group_id, user_id) select * from unnest($1::uuid[], $2::uuid[])`, [w.members.map((m) => m.groupId), w.members.map((m) => m.userId)]);
    const cols = w.collections.filter((c) => c.id !== UNFILED); // the migration created "Unfiled"
    await client.query(
      `insert into collections (id, name, position, created_by, default_permission, deleted_at)
         select id, 'c', position, $1, perm, case when deleted then now() end from unnest($2::uuid[], $3::text[], $4::text[], $5::boolean[]) as t(id, position, perm, deleted)`,
      [SYSTEM_USER, cols.map((c) => c.id), cols.map((c, i) => c.position ?? `a${String(i + 1).padStart(6, '0')}`), cols.map((c) => c.defaultPermission), cols.map((c) => c.deleted)]);
    await client.query(
      `insert into collection_access (collection_id, user_id, group_id, permission) select * from unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::text[])`,
      [w.access.map((a) => a.collectionId), w.access.map((a) => a.userId ?? null), w.access.map((a) => a.groupId ?? null), w.access.map((a) => a.permission)]);
    const statements: string[] = []; // one round trip: a big world has thousands of pages
    for (const p of w.pages) {
      await insertPage((sql) => { statements.push(sql); return Promise.resolve(); }, { id: p.id, collection_id: p.collectionId, state_epoch: p.epoch, deleted_at: p.deleted ? raw('now()') : null });
    }
    if (statements.length > 0) await client.query(statements.join(';\n'));
    await client.query('commit');
  } finally {
    await client.end();
  }
}

/** Counts the statements that reach the database through a `Queryable`. */
export function counting(inner: Queryable): { db: Queryable; statements: () => number; reset: () => void } {
  let n = 0;
  return {
    db: { query: (sql, params) => { n++; return inner.query(sql, params); } },
    statements: () => n,
    reset: () => { n = 0; },
  };
}
