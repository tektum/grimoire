import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Role, UserRecord } from '@tektum/grimoire-core/ports/user-store';
import type { Database } from '@tektum/grimoire-core/ports/database';
import { createDatabase, createOpsDatabase, type KyselyDatabase, type OperatorDatabase } from '../../src/index.js';
import { createUserStore } from '../../src/users.js';
import { adminUrl, appUrl, migratorUrl, opsUrl } from '@tektum/grimoire-test-support/database';

// Only tests in this process use this database; its afterAll drops it, never somebody else's runtime database.
const DATABASE = `grimoire_m3t05_users_${String(process.pid)}`;
const APP_URL = appUrl(DATABASE);
const ADMIN_URL = adminUrl(DATABASE);
const MIGRATION_URL = migratorUrl(DATABASE);
const POSTGRES_URL = adminUrl('postgres');
const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const CLI = path.join(ROOT, 'apps/server/dist/cli.js');
const exec = promisify(execFile);
let db: KyselyDatabase;
let ops: OperatorDatabase;

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
  ops = createOpsDatabase(opsUrl(DATABASE), { maxConnections: 25 });
}, 60_000);
afterAll(async () => {
  await db?.close();
  await ops?.close();
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
    const users = createUserStore(db, ops, 1000);
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
    const updated = await users.updateRole('legacy', created.user.id, 'viewer');
    expect(updated).toMatchObject({ ...created.user, role: 'viewer', suspended: false });
    const optional = await users.createIfAbsent({ descopeUserId: 'optional', email: 'optional@example.test', name: 'No Avatar', role: 'viewer' });
    if (optional.kind !== 'created') throw new Error('requires a created user');
    expect(optional.user).not.toHaveProperty('avatarUrl'); // a user without an avatar has no avatarUrl key (not null)
  });

  it('20 concurrent createIfAbsent calls for one sub produce one row, one created and 19 existing', async () => {
    const users = createUserStore(db, ops, 1000);
    const all = await Promise.all(Array.from({ length: 20 }, async () => users.createIfAbsent(input('race'))));
    expect(all.filter((result) => result.kind === 'created')).toHaveLength(1);
    expect(all.filter((result) => result.kind === 'existing')).toHaveLength(19);
    const rows = await db.kysely.selectFrom('users').select('id').where('descope_user_id', '=', input('race').descopeUserId).execute();
    expect(rows).toHaveLength(1);
  });

  it('the same email with another sub gives email-taken', async () => {
    const users = createUserStore(db, ops, 1000);
    const first = input('email-first', 'member', 'first@example.test');
    const second = { ...input('email-second'), email: first.email };
    expect(await users.createIfAbsent(first)).toMatchObject({ kind: 'created' });
    expect(await users.createIfAbsent(second)).toEqual({ kind: 'email-taken' });
    expect(await users.findByDescopeId(second.descopeUserId)).toBeUndefined();
  });

  it('citext unique email conflicts ignore case after another-subject insertion', async () => {
    const users = createUserStore(db, ops, 1000);
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
    const collided: UserRecord = { id: 'collision', descopeUserId: 'collision-subject', email: 'collision@example.test', name: 'Collision', role: 'member', suspended: false, tenantId: 'legacy' };
    let reads = 0;
    const failing: Database = {
      async query<Row>(source: string): Promise<readonly Row[]> {
        if (source.includes('pg_advisory_xact_lock')) return [];
        if (source.startsWith('select 1 from users where email')) return []; // the email check finds nobody
        if (source.startsWith('insert ')) throw cause;
        // The first read (the person is not there yet) finds nobody; a read after the failure would find the row, if a mutation wrongly went on to look.
        if (source.startsWith('select ') && reads++ === 0) return [];
        if (source.startsWith('select ')) {
          return [{ id: collided.id, descope_user_id: collided.descopeUserId, email: collided.email, name: collided.name, avatar_url: null, role: collided.role, suspended_at: null } as Row];
        }
        throw new Error('unexpected database operation after unique error');
      },
      transaction: (fn) => fn(failing),
      ping: () => Promise.resolve(),
      close: () => Promise.resolve(),
    };
    const caught = await createUserStore(db, { kind: 'operator', transaction: failing.transaction, close: failing.close }, 1000).createIfAbsent({ descopeUserId: collided.descopeUserId, email: collided.email, name: collided.name, role: 'member' }).catch((error: unknown) => error);
    expect(caught).toBe(cause);
    expect(caught).not.toEqual({ kind: 'email-taken' });
    expect(reads, 'no read after the failure').toBe(1);
  });

  it.each([['finds the subject\'s row', true, 'existing'], ['finds no row', false, 'email-taken']] as const)('a unique violation on the email that %s afterwards is answered %s, from a read on the operator connection', async (_name, found, kind) => {
    // A concurrent first sign-in won the email index: the read after the failure decides, and it goes to the operator connection (a row of any tenant counts).
    const raced = Object.assign(new Error('users_email_key duplicate key'), { code: '23505', constraint: 'users_email_key' });
    const row = { id: 'raced', descope_user_id: 'raced-subject', email: 'raced@example.test', name: 'Raced', avatar_url: null, role: 'member', suspended_at: null, tenant_id: 'legacy' };
    const sent: string[] = [];
    const inTransaction = (after: boolean): Database => ({
      async query<Row>(source: string): Promise<readonly Row[]> {
        sent.push(after ? `ops after: ${source.slice(0, 6)}` : source.slice(0, 6));
        if (!after && source.startsWith('insert ')) throw raced;
        return (after && found ? [row] : []) as Row[];
      },
      transaction: (fn) => fn(inTransaction(after)), ping: () => Promise.resolve(), close: () => Promise.resolve(),
    });
    let failed = false;
    const operatorDb: OperatorDatabase = { kind: 'operator', transaction: (fn) => { const tx = inTransaction(failed); failed = true; return fn(tx); }, close: () => Promise.resolve() };
    const result = await createUserStore(db, operatorDb, 1000).createIfAbsent({ descopeUserId: row.descope_user_id, email: row.email, name: row.name, role: 'member' });
    expect(result.kind).toBe(kind);
    expect(sent.at(-1)).toBe('ops after: select');
  });

  it('two simultaneous different subjects with the same email ignoring case produce one created and one email-taken', async () => {
    const users = createUserStore(db, ops, 1000);
    const first = input('shared-first', 'admin', 'shared@example.test');
    const second = { ...input('shared-second'), email: 'SHARED@EXAMPLE.TEST' };
    const results = await Promise.all([users.createIfAbsent(first), users.createIfAbsent(second)]);
    expect(results.filter((r) => r.kind === 'created')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'email-taken')).toHaveLength(1);
    expect(await db.kysely.selectFrom('users').select('id').where('email', '=', 'SHARED@example.test').execute()).toHaveLength(1);
  });

  it('existing-subject conflict reads the row rather than changing role or personal fields', async () => {
    const users = createUserStore(db, ops, 1000);
    const first = input('stable', 'member');
    const created = await users.createIfAbsent(first);
    if (created.kind === 'email-taken' || created.kind === 'tenant-full') throw new Error('the first user is created, not refused');
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
    const users = createUserStore(db, ops, 1000);
    const found = await users.findByDescopeId('suspended-subject');
    expect(found).toMatchObject({ descopeUserId: 'suspended-subject', suspended: true, role: 'viewer', name: 'Suspended' });
    if (!found) throw new Error('seed must exist');
    expect(await users.updateRole('legacy', found.id, 'admin')).toMatchObject({ role: 'admin', suspended: true });
    expect(await users.updateRole('legacy', '00000000-0000-4000-8000-00000000dead', 'admin')).toBeUndefined();
    // Scoped to the tenant it is given: the id of a person of another tenant changes nothing (docs/tenancy.md section 3.2).
    expect(await users.updateRole('T-other', found.id, 'viewer')).toBeUndefined();
    expect(await users.findByDescopeId(found.descopeUserId)).toMatchObject({ role: 'admin' });
  });
});

describe('createIfAbsent when the same user signs in several times at once', () => {
  it('every call gets the one row (one created, the rest existing): a clash on the email index of that same row is not email-taken', async () => {
    const users = createUserStore(db, ops, 1000);
    for (let round = 0; round < 10; round++) {
      const values = { descopeUserId: `race-${String(round)}`, email: `race-${String(round)}@example.test`, name: 'Racer', role: 'member' as Role };
      const results = await Promise.all(Array.from({ length: 8 }, () => users.createIfAbsent(values)));
      expect(results.map((r) => r.kind).filter((k) => k === 'email-taken')).toEqual([]);
      expect(results.filter((r) => r.kind === 'created')).toHaveLength(1);
      expect(new Set(results.map((r) => ('user' in r ? r.user.id : ''))).size).toBe(1);
    }
  });

  it('a different subject with the same email is still email-taken', async () => {
    const users = createUserStore(db, ops, 1000);
    await users.createIfAbsent({ descopeUserId: 'taken-a', email: 'taken@example.test', name: 'A', role: 'member' as Role });
    expect(await users.createIfAbsent({ descopeUserId: 'taken-b', email: 'taken@example.test', name: 'B', role: 'member' as Role })).toEqual({ kind: 'email-taken' });
  });
});


describe('the tenant of a new person (docs/tenancy.md section 3.1)', () => {
  const store = () => createUserStore(db, ops, 1000);
  const tenants = async (): Promise<readonly { id: string; name: string; domain: string | null }[]> => db.query('select id, name, domain from tenants order by id');
  const person = (n: string) => ({ descopeUserId: `tenant-subject-${n}`, email: `${n}@tenant-${n}.test`, name: n, role: 'member' as Role });

  it('makes the tenant with the person in one statement, names it after the domain, and a second person of it joins the same row', async () => {
    const first = await store().createIfAbsent({ ...person('a'), tenant: { id: 'T-a', name: 'tenant-a.test' } });
    expect(first).toMatchObject({ kind: 'created', user: { tenantId: 'T-a' } });
    const second = await store().createIfAbsent({ ...person('a2'), email: 'second@tenant-a.test', tenant: { id: 'T-a', name: 'tenant-a.test' } });
    expect(second).toMatchObject({ kind: 'created', user: { tenantId: 'T-a' } });
    expect((await tenants()).filter((t) => t.id === 'T-a')).toEqual([{ id: 'T-a', name: 'tenant-a.test', domain: 'tenant-a.test' }]);
  });

  it('puts a person who names no tenant in legacy', async () => {
    expect(await store().createIfAbsent(person('b'))).toMatchObject({ kind: 'created', user: { tenantId: 'legacy' } });
  });

  it('leaves no tenant behind when the person is refused because the email is taken', async () => {
    await store().createIfAbsent(person('c'));
    const refused = await store().createIfAbsent({ ...person('c'), descopeUserId: 'tenant-subject-c2', tenant: { id: 'T-c', name: 'tenant-c.test' } });
    expect(refused).toEqual({ kind: 'email-taken' });
    expect((await tenants()).map((t) => t.id)).not.toContain('T-c');
  });

  it('leaves no tenant behind when the person already exists, as the loser of a race between two first sign-ins of one subject', async () => {
    await store().createIfAbsent({ ...person('e'), tenant: { id: 'T-e', name: 'tenant-e.test' } });
    const loser = await store().createIfAbsent({ ...person('e'), tenant: { id: 'T-e-late', name: 'tenant-e-late.test' } });
    expect(loser).toMatchObject({ kind: 'existing', user: { tenantId: 'T-e' } });
    expect((await tenants()).map((t) => t.id)).not.toContain('T-e-late');
  });

  it('refuses a tenant id outside the shape the database allows, and makes nothing', async () => {
    await expect(store().createIfAbsent({ ...person('d'), tenant: { id: 'not a valid id', name: 'tenant-d.test' } })).rejects.toMatchObject({ code: '23514' });
    expect(await store().findByDescopeId('tenant-subject-d')).toBeUndefined();
  });
});
