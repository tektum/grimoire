import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, createOpsDatabase, type KyselyDatabase, type OperatorDatabase } from '../../src/index.js';
import { createIdempotency } from '../../src/idempotency.js';
import { adminUrl, appUrl, migratorUrl, opsUrl } from '@tektum/grimoire-test-support/database';

// Only tests in this process use this database; its afterAll drops it, never somebody else's runtime database.
const DATABASE = `grimoire_m4t02_idem_${String(process.pid)}`;
const APP_URL = appUrl(DATABASE);
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
  await exec(process.execPath, [CLI, 'migrate'], { env: { ...process.env, GRIMOIRE_DATABASE_MIGRATION_URL: MIGRATION_URL } });
  db = createDatabase(APP_URL, { maxConnections: 25 });
  ops = createOpsDatabase(opsUrl(DATABASE));
}, 60_000);
afterAll(async () => {
  await db?.close();
  await ops?.close();
  await runSql(POSTGRES_URL, `drop database if exists ${DATABASE} with (force)`);
});

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const answer = { status: 201, body: { id: 'p1', nested: { list: [1, 'two', null] } } };

describe('the PostgreSQL IdempotencyStore', () => {
  it('claims once; a second claim is refused while the first runs; after complete the same request replays the stored JSON', async () => {
    const store = createIdempotency(db, ops);
    const user = randomUUID();
    expect(await store.claim(user, 'k', HASH_A)).toEqual({ kind: 'claimed' });
    expect(await store.claim(user, 'k', HASH_A)).toEqual({ kind: 'conflict' });
    await store.complete(user, 'k', answer);
    expect(await store.claim(user, 'k', HASH_A)).toEqual({ kind: 'replay', response: answer });
  });

  it('refuses the same key with another request hash, running or finished', async () => {
    const store = createIdempotency(db, ops);
    const user = randomUUID();
    await store.claim(user, 'k', HASH_A);
    expect(await store.claim(user, 'k', HASH_B)).toEqual({ kind: 'conflict' });
    await store.complete(user, 'k', answer);
    expect(await store.claim(user, 'k', HASH_B)).toEqual({ kind: 'conflict' });
  });

  it('keeps users apart: the same key and hash is a fresh claim for another user', async () => {
    const store = createIdempotency(db, ops);
    expect((await store.claim(randomUUID(), 'shared', HASH_A)).kind).toBe('claimed');
    expect((await store.claim(randomUUID(), 'shared', HASH_A)).kind).toBe('claimed');
  });

  it('lets exactly one of many simultaneous first claims win', async () => {
    const store = createIdempotency(db, ops);
    const user = randomUUID();
    const results = await Promise.all(Array.from({ length: 20 }, () => store.claim(user, 'race', HASH_A)));
    expect(results.filter((r) => r.kind === 'claimed')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'conflict')).toHaveLength(19);
  });

  it('stores a response without a body and replays it as null', async () => {
    const store = createIdempotency(db, ops);
    const user = randomUUID();
    await store.claim(user, 'k', HASH_A);
    await store.complete(user, 'k', { status: 204, body: null });
    expect(await store.claim(user, 'k', HASH_A)).toEqual({ kind: 'replay', response: { status: 204, body: null } });
  });

  it('release frees a running claim, and never removes a finished answer', async () => {
    const store = createIdempotency(db, ops);
    const user = randomUUID();
    await store.claim(user, 'run', HASH_A);
    await store.release(user, 'run');
    expect(await store.claim(user, 'run', HASH_B)).toEqual({ kind: 'claimed' });
    await store.claim(user, 'done', HASH_A);
    await store.complete(user, 'done', answer);
    await store.release(user, 'done');
    expect((await store.claim(user, 'done', HASH_A)).kind).toBe('replay');
  });

  it('deletes the rows created before the cutoff and only those, and the key is usable again', async () => {
    const store = createIdempotency(db, ops);
    const user = randomUUID();
    await store.claim(user, 'old', HASH_A);
    await store.complete(user, 'old', answer);
    await db.query(`update idempotency_keys set created_at = now() - interval '25 hours' where user_id = $1 and key = 'old'`, [user]);
    await store.claim(user, 'young', HASH_A);
    expect(await store.deleteCreatedBefore(Date.now() - 24 * 60 * 60 * 1000)).toBeGreaterThanOrEqual(1);
    expect((await store.claim(user, 'old', HASH_B)).kind).toBe('claimed');
    expect((await store.claim(user, 'young', HASH_A)).kind).toBe('conflict');
  });

  it('stores a key in the tenant of its user, and in legacy for a user it does not know', async () => {
    const store = createIdempotency(db, ops);
    await db.query(`insert into tenants (id, name) values ('T-idem', 'T-idem')`);
    const rows = await db.query<{ id: string }>(`insert into users (descope_user_id, email, name, role, tenant_id) values ('idem', 'idem@example.com', 'idem', 'member', 'T-idem') returning id`);
    const user = rows[0]!.id;
    const unknown = randomUUID();
    await store.claim(user, 'k', HASH_A);
    await store.claim(unknown, 'k', HASH_A);
    const tenants = await db.query<{ tenant_id: string }>(`select tenant_id from idempotency_keys where user_id in ($1, $2) order by user_id = $1 desc`, [user, unknown]);
    expect(tenants.map((row) => row.tenant_id)).toEqual(['T-idem', 'legacy']);
  });
});
