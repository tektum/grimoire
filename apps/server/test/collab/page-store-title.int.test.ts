import { createHash, randomUUID } from 'node:crypto';
import { createDatabase, createOpsDatabase, type KyselyDatabase, type OperatorDatabase } from '@tektum/grimoire-adapter-db-kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPageStore } from '@tektum/grimoire-adapter-db-kysely';
import { insertPage, opsUrl } from '@tektum/grimoire-test-support/database';
import { appUrl, createTestDatabase, dropTestDatabase, requireBuild, sqlAdmin } from '../server/support/harness.js';

const DB = 'grimoire_m3t03_title';
const clock = { now: () => Date.now() };
const sha = (title: string, markdown: string): Buffer => createHash('sha256').update(title, 'utf8').update('\0').update(markdown, 'utf8').digest();
const converted = (over: { markdown?: string; state?: Uint8Array } = {}) => ({
  kind: 'converted' as const, state: over.state ?? new Uint8Array([9, 9]), markdown: over.markdown ?? 'M', text: 'T', epoch: 0, editedAt: Date.parse('2026-01-02T03:04:05Z'),
});
const newRow = async (title = ''): Promise<string> => {
  const id = randomUUID();
  await insertPage((sql) => sqlAdmin(DB, sql), { id, title });
  return id;
};
const hashOf = async (id: string): Promise<Buffer | null> => (await sqlAdmin<{ markdown_hash: Buffer | null }>(DB, `select markdown_hash from pages where id = '${id}'`))[0]?.markdown_hash ?? null;
const updatedAt = async (id: string): Promise<string> => (await sqlAdmin<{ u: string }>(DB, `select updated_at::text as u from pages where id = '${id}'`))[0]?.u ?? '';

let db: KyselyDatabase;
let ops: OperatorDatabase;
type K = KyselyDatabase['kysely'];
/** Records every statement the store sends: each of its calls takes a connection of `inner.kysely` for its scoped transaction. */
const counted = (inner: KyselyDatabase, sink: string[]): KyselyDatabase => {
  const wrap = (one: K): K => new Proxy(one, { get: (k, p) => (p === 'executeQuery' ? (q: Parameters<K['executeQuery']>[0]) => { sink.push('sql' in q ? q.sql : q.compile().sql); return k.executeQuery(q); } : Reflect.get(k, p)) as unknown });
  const connection = () => ({ execute: <T>(fn: (one: K) => Promise<T>) => inner.kysely.connection().execute((one) => fn(wrap(one))) });
  return { ...inner, kysely: new Proxy(inner.kysely, { get: (k, p) => (p === 'connection' ? connection : Reflect.get(k, p)) as unknown }) };
};

beforeAll(async () => { requireBuild(); await createTestDatabase(DB, true); db = createDatabase(appUrl(DB), { maxConnections: 4 }); ops = createOpsDatabase(opsUrl(DB)); }, 60_000);
afterAll(async () => { await db.close(); await ops.close(); await dropTestDatabase(DB); });

describe('the save skip follows title and Markdown (R4.21)', () => {
  it('markdown_hash is SHA-256 of the title, a NUL byte and the Markdown', async () => {
    const id = await newRow('Hello');
    await createPageStore(db, ops, clock).store('legacy', id, converted({ markdown: 'Body' }));
    expect(await hashOf(id)).toEqual(sha('Hello', 'Body'));
  });

  it('an unchanged title and Markdown write nothing: no UPDATE statement, updated_at identical', async () => {
    const id = await newRow('Same');
    const sent: string[] = [];
    const store = createPageStore(counted(db, sent), ops, clock);
    await store.store('legacy', id, converted());
    const first = await updatedAt(id);
    sent.length = 0;
    await new Promise((r) => setTimeout(r, 20));
    expect(await store.store('legacy', id, converted())).toEqual({ written: false, reason: 'unchanged' });
    expect(sent.some((s) => /^\s*update/i.test(s))).toBe(false);
    expect(await updatedAt(id)).toBe(first);
  });

  it('changing only pages.title and then saving with identical Markdown writes the row', async () => {
    const id = await newRow('Before');
    const store = createPageStore(db, ops, clock);
    await store.store('legacy', id, converted());
    expect(await hashOf(id)).toEqual(sha('Before', 'M'));
    await sqlAdmin(DB, `update pages set title = 'After' where id = '${id}'`);
    const sent: string[] = [];
    expect(await createPageStore(counted(db, sent), ops, clock).store('legacy', id, converted())).toEqual({ written: true });
    expect(sent.some((s) => /^\s*update/i.test(s))).toBe(true);
    expect(await hashOf(id)).toEqual(sha('After', 'M'));
  });

  it('with the title unchanged, identical Markdown and different state still writes the state (commit 4112063), keeping the hash', async () => {
    const id = await newRow('T');
    const store = createPageStore(db, ops, clock);
    await store.store('legacy', id, converted());
    expect(await store.store('legacy', id, converted({ state: new Uint8Array([7]) }))).toEqual({ written: true });
    expect(await hashOf(id)).toEqual(sha('T', 'M'));
    expect(Buffer.from((await sqlAdmin<{ ydoc: Buffer }>(DB, `select ydoc from pages where id = '${id}'`))[0]?.ydoc ?? '')).toEqual(Buffer.from([7]));
  });

  it('a hash written before the migration is null after it and is written once by the next save', async () => {
    const id = await newRow('Old');
    const store = createPageStore(db, ops, clock);
    // A null hash is what the migration leaves behind (its own test asserts it): the first save writes, the second finds nothing to do.
    await sqlAdmin(DB, `update pages set markdown = 'M', markdown_hash = null where id = '${id}'`);
    expect(await store.store('legacy', id, converted())).toEqual({ written: true });
    expect(await hashOf(id)).toEqual(sha('Old', 'M'));
    expect(await store.store('legacy', id, converted())).toEqual({ written: false, reason: 'unchanged' });
  });
});
