import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';
import { devDatabaseUrl, insertPage, raw } from '@tektum/grimoire-test-support/database';
import type { KyselyDatabase } from '../../src/index.js';
import { aroundScoped } from '../collections/support.js';
import type { World } from '@tektum/grimoire-core/testing/fake-access-store';
import { createAuthorizer } from '@tektum/grimoire-core/authorize/authorizer';
import type { AccessStore } from '@tektum/grimoire-core/ports/access-store';

// Dev-only credentials of the Compose database (`make db-up`). Every test file creates and drops its own database.
const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
export const urlFor = (role: 'grimoire_admin' | 'grimoire_migrator' | 'grimoire_app', db: string): string => devDatabaseUrl(role, db);

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

/** `inner` with the statements its scoped connections send counted (not the `begin` with the tenant, nor the `commit`). */
export function counting(inner: KyselyDatabase): { db: KyselyDatabase; statements: () => number; reset: () => void } {
  let n = 0;
  return {
    db: aroundScoped(inner, (sql, run) => { if (!/^(begin|commit|rollback)\b/.test(sql)) n++; return run(); }),
    statements: () => n,
    reset: () => { n = 0; },
  };
}

// Two tenants in one database (docs/tenancy.md 3.3, 3.4): an admin of `tenant-a` with its collection and page, an admin of `tenant-b` with its own. The ids are fixed and apart from the shared table's.
const tid = (n: number): string => `00000000-0000-4000-8000-000000fa00${String(n).padStart(2, '0')}`;
export const TENANTS = { userA: tid(1), userB: tid(2), colA: tid(3), colB: tid(4), pageA: tid(5), pageB: tid(6) };
const tenantWorld: World = {
  users: [{ id: TENANTS.userA, role: 'admin', suspended: false }, { id: TENANTS.userB, role: 'admin', suspended: false }],
  groups: [], members: [], access: [],
  collections: [{ id: TENANTS.colA, deleted: false, defaultPermission: 'read_write' }, { id: TENANTS.colB, deleted: false, defaultPermission: 'read_write' }],
  pages: [{ id: TENANTS.pageA, collectionId: TENANTS.colA, epoch: 1, deleted: false }, { id: TENANTS.pageB, collectionId: TENANTS.colB, epoch: 1, deleted: false }],
};

/** Loads the two-tenant world: everything goes in as `legacy`, then each tenant takes its user, collection and page in one transaction (the keys between them are checked at commit). Neither tenant is `legacy`, where the shared table's world lives, so the fixture is in nobody's list there. */
export async function loadTenantWorld(db: string): Promise<void> {
  await loadWorld(db, tenantWorld);
  const admin = urlFor('grimoire_admin', db);
  await sqlAs(admin, `insert into tenants (id, name) values ('tenant-a', 'A'), ('tenant-b', 'B')`);
  await sqlAs(admin, `begin;
    update users set tenant_id = 'tenant-a' where id = '${TENANTS.userA}';
    update collections set tenant_id = 'tenant-a' where id = '${TENANTS.colA}';
    update pages set tenant_id = 'tenant-a' where id = '${TENANTS.pageA}';
    update users set tenant_id = 'tenant-b' where id = '${TENANTS.userB}';
    update collections set tenant_id = 'tenant-b' where id = '${TENANTS.colB}';
    update pages set tenant_id = 'tenant-b' where id = '${TENANTS.pageB}';
    commit;`);
}

/** What the store must do with the two tenants; the number of answers that are wrong (0 for a correct store). */
export async function tenantFailures(store: AccessStore): Promise<number> {
  const a = createAuthorizer(store);
  // Each person asks from their own tenant, as the token says; the page or collection asked for may be another tenant's.
  const tenantOf = (userId: string): string => (userId === TENANTS.userA ? 'tenant-a' : 'tenant-b');
  const level = async (userId: string, pageId: string): Promise<string> => (await a.check({ tenantId: tenantOf(userId), userId, pageId })).access;
  const colLevel = async (userId: string, collectionId: string): Promise<string> => (await a.checkCollection({ tenantId: tenantOf(userId), userId, collectionId })).access;
  const ids = async (userId: string): Promise<string[]> => (await a.visibleCollections(tenantOf(userId), userId)).map((c) => c.collectionId);
  const T = TENANTS;
  const wrong = [
    (await level(T.userA, T.pageA)) !== 'read-write', (await level(T.userB, T.pageB)) !== 'read-write',
    (await level(T.userA, T.pageB)) !== 'none', (await level(T.userB, T.pageA)) !== 'none',
    (await colLevel(T.userA, T.colA)) !== 'read-write', (await colLevel(T.userB, T.colB)) !== 'read-write',
    (await colLevel(T.userA, T.colB)) !== 'none', (await colLevel(T.userB, T.colA)) !== 'none',
    (await ids(T.userA)).includes(T.colB), (await ids(T.userB)).join() !== T.colB,
  ];
  return wrong.filter(Boolean).length;
}
