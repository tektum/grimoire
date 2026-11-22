import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Role, UserRecord } from '@tektum/grimoire-core/ports/user-store';
import type { Queryable } from '@tektum/grimoire-core/ports/database';
import { createDatabase, type KyselyDatabase } from '../../src/index.js';
import { createUserStore } from '../../src/users.js';

// Only tests in this process use this database; its afterAll drops it, never somebody else's runtime database.
const DATABASE = `grimoire_m3t05_users_${String(process.pid)}`;
const APP_URL = `postgresql://grimoire_app:grimoire-dev@127.0.0.1:55432/${DATABASE}`;
const ADMIN_URL = `postgresql://grimoire_admin:grimoire-dev@127.0.0.1:55432/${DATABASE}`;
const MIGRATION_URL = `postgresql://grimoire_migrator:grimoire-dev@127.0.0.1:55432/${DATABASE}`;
const POSTGRES_URL = 'postgresql://grimoire_admin:grimoire-dev@127.0.0.1:55432/postgres';
const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const CLI = path.join(ROOT, 'apps/server/dist/cli.js');
const exec = promisify(execFile);
let db: KyselyDatabase;

async function runSql(url: string, sql: string): Promise<void> {
  const postgres = createDatabase(url, { maxConnections: 1 });
  try { await postgres.query(sql); }
  finally { await postgres.close(); }
}

beforeAll(async () => {
  await runSql(POSTGRES_URL, `drop database if exists ${DATABASE} with (force)`);
  await runSql(POSTGRES_URL, `create database ${DATABASE} owner grimoire_migrator`);
  const env = { ...process.env, GRIMOIRE_DATABASE_MIGRATION_URL: MIGRATION_URL };
  await exec(process.execPath, [CLI, 'migrate'], { env });
  db = createDatabase(APP_URL, { maxConnections: 25 });
}, 60_000);
afterAll(async () => {
  await db?.close();
  await runSql(POSTGRES_URL, `drop database if exists ${DATABASE} with (force)`);
});

const input = (label: string, role: Role = 'member', email = `${label}@example.test`) => ({ descopeUserId: `store-${label}`, email, name: 'Private Name', avatarUrl: 'https://example.test/avatar', role });

describe('users migration: no authentication secrets', () => {
  it('information_schema users columns have no name matching pass|secret|credential|token', async () => {
    const columns = await db.query<{ column_name: string }>('select column_name from information_schema.columns where table_schema = $1 and table_name = $2', ['public', 'users']);
    const names = columns.map((row) => row.column_name);
    expect(names).toContain('descope_user_id');
    expect(names.some((column) => /pass|secret|credential|token/i.test(column))).toBe(false);
  });
});

describe('createUserStore', () => {
  it('maps find/insert/avatar/suspended/last_seen and updateRole while preserving all identity values', async () => {
    const users = createUserStore(db);
    expect(await users.findByDescopeId('not-present')).toBeUndefined();
    const values = { descopeUserId: 'store-mapping', email: 'mapping@example.test', name: 'Private Name', avatarUrl: 'https://example.test/avatar', role: 'member' as Role };
    const created = await users.createIfAbsent(values);
    expect(created).toMatchObject({ kind: 'created', user: { ...values, suspended: false } });
    if (created.kind !== 'created') throw new Error('requires a created user');
    expect(created.user.id).toMatch(/^[0-9a-f-]{36}$/);
    // `last_seen_at` is not part of the record the store returns: read the column itself, so that dropping the insert's now() fails here.
    const seen = await db.query<{ seen: boolean }>('select last_seen_at is not null as seen from users where descope_user_id = $1', [values.descopeUserId]);
    expect(seen[0]?.seen).toBe(true);
    expect(await users.findByDescopeId(values.descopeUserId)).toEqual(created.user);
    const updated = await users.updateRole(created.user.id, 'viewer');
    expect(updated).toMatchObject({ ...created.user, role: 'viewer', suspended: false });
    const optional = await users.createIfAbsent({ descopeUserId: 'optional', email: 'optional@example.test', name: 'No Avatar', role: 'viewer' });
    if (optional.kind !== 'created') throw new Error('requires a created user');
    expect(optional.user).not.toHaveProperty('avatarUrl'); // a user without an avatar has no avatarUrl key (not null)
  });

  it('20 concurrent createIfAbsent calls for one sub produce one row, one created and 19 existing', async () => {
    const users = createUserStore(db);
    const all = await Promise.all(Array.from({ length: 20 }, async () => users.createIfAbsent(input('race'))));
    expect(all.filter((result) => result.kind === 'created')).toHaveLength(1);
    expect(all.filter((result) => result.kind === 'existing')).toHaveLength(19);
    const rows = await db.kysely.selectFrom('users').select('id').where('descope_user_id', '=', input('race').descopeUserId).execute();
    expect(rows).toHaveLength(1);
  });

  it('the same email with another sub gives email-taken', async () => {
    const users = createUserStore(db);
    const first = input('email-first', 'member', 'first@example.test');
    const second = { ...input('email-second'), email: first.email };
    expect(await users.createIfAbsent(first)).toMatchObject({ kind: 'created' });
    expect(await users.createIfAbsent(second)).toEqual({ kind: 'email-taken' });
    expect(await users.findByDescopeId(second.descopeUserId)).toBeUndefined();
  });

  it('citext unique email conflicts ignore case after another-subject insertion', async () => {
    const users = createUserStore(db);
    const first = input('citext-first', 'admin', 'person@example.test');
    const second = { ...input('citext-second'), email: 'PERSON@example.TEST' };
    expect(await users.createIfAbsent(first)).toMatchObject({ kind: 'created' });
    expect(await users.createIfAbsent(second)).toEqual({ kind: 'email-taken' });
    expect(await users.findByDescopeId(second.descopeUserId)).toBeUndefined();
  });

  it('a unique violation on users_pkey is an operational error and is never misreported as email-taken', async () => {
    // The generated id collision cannot practically be induced. Synthesize only pg's failure boundary; keep a matching
    // publicly returned database row for the follow-up select if a mutation wrongly suppresses this other constraint error.
    const cause = Object.assign(new Error('users_pkey duplicate key'), { code: '23505', constraint: 'users_pkey' });
    const collided: UserRecord = { id: 'collision', descopeUserId: 'collision-subject', email: 'collision@example.test', name: 'Collision', role: 'member', suspended: false };
    let readAlreadySupplied = false;
    const failing: Queryable = {
      async query<Row>(source: string): Promise<readonly Row[]> {
        if (source.startsWith('insert ')) throw cause;
        if (source.startsWith('select ') && !readAlreadySupplied) {
          readAlreadySupplied = true;
          return [{ id: collided.id, descope_user_id: collided.descopeUserId, email: collided.email, name: collided.name, avatar_url: null, role: collided.role, suspended_at: null } as Row];
        }
        throw new Error('unexpected database operation after unique error');
      },
    };
    const caught = await createUserStore(failing).createIfAbsent({ descopeUserId: collided.descopeUserId, email: collided.email, name: collided.name, role: 'member' }).catch((error: unknown) => error);
    expect(caught).toBe(cause);
    expect(caught).not.toEqual({ kind: 'email-taken' });
    expect(readAlreadySupplied).toBe(false);
  });

  it('two simultaneous different subjects with the same email ignoring case produce one created and one email-taken', async () => {
    const users = createUserStore(db);
    const first = input('shared-first', 'admin', 'shared@example.test');
    const second = { ...input('shared-second'), email: 'SHARED@EXAMPLE.TEST' };
    const results = await Promise.all([users.createIfAbsent(first), users.createIfAbsent(second)]);
    expect(results.filter((r) => r.kind === 'created')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'email-taken')).toHaveLength(1);
    expect(await db.kysely.selectFrom('users').select('id').where('email', '=', 'SHARED@example.test').execute()).toHaveLength(1);
  });

  it('existing-subject conflict reads the row rather than changing role or personal fields', async () => {
    const users = createUserStore(db);
    const first = input('stable', 'member');
    const created = await users.createIfAbsent(first);
    expect(await users.createIfAbsent({ ...first, email: 'changed@example.test', name: 'Changed', role: 'admin' })).toEqual({ kind: 'existing', user: created.user });
  });

  it('reads suspension and local-only updateRole on a suspension-seeded row', async () => {
    const admin = createDatabase(ADMIN_URL, { maxConnections: 1 });
    try {
      await admin.query(
        "insert into users (descope_user_id, email, name, role, suspended_at, last_seen_at) values ($1, $2, $3, 'viewer', now(), now())",
        ['suspended-subject', 'suspended@example.test', 'Suspended'],
      );
    } finally { await admin.close(); }
    const users = createUserStore(db);
    const found = await users.findByDescopeId('suspended-subject');
    expect(found).toMatchObject({ descopeUserId: 'suspended-subject', suspended: true, role: 'viewer', name: 'Suspended' });
    if (!found) throw new Error('seed must exist');
    expect(await users.updateRole(found.id, 'admin')).toMatchObject({ role: 'admin', suspended: true });
    expect(await users.updateRole('00000000-0000-4000-8000-00000000dead', 'admin')).toBeUndefined();
  });
});
