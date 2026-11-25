import { markdownHash } from '@tektum/grimoire-core/pages/hash';
import { createHash, randomUUID } from 'node:crypto';
import { createDatabase } from '@tektum/grimoire-adapter-db-kysely';
import type { Database } from '@tektum/grimoire-core/ports/database';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPageStore } from '../src/page-store.js';
import { insertPage } from '@tektum/grimoire-test-support/database';
import { appUrl, createTestDatabase, dropTestDatabase, requireBuild, sqlAdmin } from './page-store-support.js';

const DB = `grimoire_m2t04_store_${String(process.pid)}`;
const run = (sql: string): Promise<unknown> => sqlAdmin(DB, sql);
const clock = { now: () => Date.now() };
const expectedHash = (title: string, markdown: string): Buffer => createHash('sha256').update(title, 'utf8').update('\0').update(markdown, 'utf8').digest();
/** `last_edited_by` has a foreign key since 0004: an editor must be a user row. */
const newUser = async (): Promise<string> => {
  const id = randomUUID();
  await sqlAdmin(DB, `insert into users (id, descope_user_id, email, name) values ('${id}', '${id}', '${id}@example.invalid', 'U')`);
  return id;
};
const newRow = async (): Promise<string> => {
  const id = randomUUID();
  await insertPage(run, { id, markdown: null }); // the page store ignores the collection: Unfiled is fine
  return id;
};
const row = async (id: string) => (await sqlAdmin<{ ydoc: Buffer | null; markdown: string | null; text_content: string | null; markdown_hash: Buffer | null; last_edited_by: string | null; updated_at: string; epoch: number }>(
  DB, `select ydoc, markdown, text_content, markdown_hash, last_edited_by, updated_at::text, state_epoch as epoch from pages where id = '${id}'`))[0];

/** Waits until the clock the store writes with (`clock.now()`, milliseconds) has moved past a reading taken now, so that a write made after this call gets a later timestamp than any write before it. */
const databaseClockMoves = async (): Promise<void> => {
  const t0 = clock.now();
  await vi.waitFor(() => { expect(clock.now()).toBeGreaterThan(t0); }, { timeout: 2000, interval: 1 });
};

let db: Database;
/** Counts every statement the store sends. */
const counted = (inner: Database, sink: string[]): Database => ({
  query: (sql, params) => { sink.push(sql); return inner.query(sql, params); },
  transaction: (fn) => inner.transaction((tx) => fn({ query: (sql, params) => { sink.push(sql); return tx.query(sql, params); } })),
  ping: () => inner.ping(), close: () => inner.close(),
});

beforeAll(async () => { requireBuild(); await createTestDatabase(DB, true); db = createDatabase(appUrl(DB), { maxConnections: 24 }); }, 60_000);
afterAll(async () => { await db.close(); await dropTestDatabase(DB); });

it('save hashes include the row title (page-store move regression)', async () => {
  const id = await newRow();
  await sqlAdmin(DB, `update pages set title = 'Saved title' where id = '${id}'`);
  const store = createPageStore(db, clock);
  await store.store(id, { kind: 'converted', state: new Uint8Array([1]), markdown: 'Body', text: 'Body', epoch: 0, editedAt: Date.now() });
  expect((await row(id))?.markdown_hash).toEqual(expectedHash('Saved title', 'Body'));
  expect(Buffer.from((await row(id))?.markdown_hash ?? '').equals(markdownHash('Saved title', 'Body'))).toBe(true);
});

describe('seed', () => {
  it('20 concurrent seeds of one row call build exactly once and return the same state', async () => {
    const id = randomUUID();
    await insertPage(run, { id, markdown: '# Seeded' });
    const sent: string[] = [];
    const store = createPageStore(counted(db, sent), clock);
    let builds = 0;
    let release: () => void = () => undefined;
    const open = new Promise<void>((resolve) => { release = resolve; });
    // The 20 calls are all made before any of them can continue (nothing is awaited in between), so by the time the first build starts the other 19 have
    // called seed too; holding that build open until the test releases it means a second build could only start if single flight were broken.
    const build = async (md: string): Promise<Uint8Array> => { builds++; await open; return new TextEncoder().encode(`state of ${md}`); };
    const all = Promise.all(Array.from({ length: 20 }, () => store.seed(id, build)));
    await vi.waitFor(() => { expect(builds).toBeGreaterThanOrEqual(1); }, { timeout: 5000, interval: 5 });
    // With single flight exactly one read of the row has been sent by now; without it every one of the 20 calls would have sent its own (the statement is counted
    // when it is issued), so this fails when the in-process single flight is removed, not only when a second build happens to start.
    expect(sent.filter((q) => /select[\s\S]+from\s+pages/i.test(q))).toHaveLength(1);
    release();
    const results = await all;
    expect(builds).toBe(1);
    expect(results.filter((r) => r.seeded)).toHaveLength(1);
    const states = new Set(results.map((r) => Buffer.from(r.state ?? new Uint8Array()).toString()));
    expect([...states]).toEqual(['state of # Seeded']);
    expect(Buffer.from((await row(id))?.ydoc ?? '').toString()).toBe('state of # Seeded');
  });

  it('a row with state, or with neither state nor Markdown, is not built', async () => {
    const store = createPageStore(db, clock);
    const withState = randomUUID();
    await insertPage(run, { id: withState, ydoc: new Uint8Array([1, 2]), markdown: 'md' });
    const empty = await newRow();
    const build = (): Promise<Uint8Array> => Promise.reject(new Error('must not be called'));
    expect(await store.seed(withState, build)).toMatchObject({ seeded: false, state: new Uint8Array([1, 2]) });
    expect(await store.seed(empty, build)).toMatchObject({ seeded: false, state: null });
    expect(await store.seed(randomUUID(), build)).toMatchObject({ seeded: false, state: null });
  });

  it('with a lock held by another connection and a lock timeout of 1 s the seed fails with a lock-timeout error', async () => {
    const id = randomUUID();
    await insertPage(run, { id, markdown: 'md' });
    const other = createDatabase(appUrl(DB), { maxConnections: 1 });
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => { release = r; });
    let locked: () => void = () => undefined;
    const lockTaken = new Promise<void>((r) => { locked = r; });
    const holder = other.transaction(async (tx) => { await tx.query('select 1 from pages where id = $1 for update', [id]); locked(); await held; });
    holder.catch(() => undefined); // a holder that fails before it locks is seen through the race below, not as an unhandled rejection
    try {
      // The holder either takes the lock (lockTaken) or fails first (the race rejects with its error): the test fails at once and the cleanup below runs.
      await Promise.race([lockTaken, holder.then(() => { throw new Error('the holder ended before it took the lock'); })]);
      const t0 = Date.now();
      await expect(createPageStore(db, clock, { lockTimeoutMs: 1000 }).seed(id, () => Promise.resolve(new Uint8Array([1])))).rejects.toMatchObject({ code: '55P03' });
      expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    } finally {
      release(); await holder.catch(() => undefined); await other.close();
    }
    expect((await row(id))?.ydoc).toBeNull();
  });
});

describe('store', () => {
  const converted = (over: Record<string, unknown> = {}) => ({ kind: 'converted' as const, state: new Uint8Array([9, 9]), markdown: 'M', text: 'T', epoch: 0, editedAt: Date.parse('2026-01-02T03:04:05Z'), ...over });

  it('converted: state, Markdown, text, hash, editor, edit time and updated_at are written together', async () => {
    const id = await newRow();
    const editor = await newUser();
    const before = (await row(id))?.updated_at;
    await databaseClockMoves();
    expect(await createPageStore(db, clock).store(id, converted({ editedBy: editor }))).toEqual({ written: true });
    const r = await row(id);
    expect(r).toMatchObject({ markdown: 'M', text_content: 'T', last_edited_by: editor });
    expect(Buffer.from(r?.ydoc ?? '')).toEqual(Buffer.from([9, 9]));
    expect(Buffer.from(r?.markdown_hash ?? '')).toEqual(expectedHash('', 'M'));
    expect((r?.updated_at ?? '') > (before ?? '')).toBe(true);
    const at = await sqlAdmin<{ t: string }>(DB, `select last_edited_at::text as t from pages where id = '${id}'`);
    expect(at[0]?.t).toContain('2026-01-02 03:04:05');
  });

  it('an equal hash writes nothing: updated_at is identical and no UPDATE statement is sent', async () => {
    const id = await newRow();
    const sent: string[] = [];
    const store = createPageStore(counted(db, sent), clock);
    await store.store(id, converted());
    const first = (await row(id))?.updated_at;
    sent.length = 0;
    await databaseClockMoves();
    expect(await store.store(id, converted())).toEqual({ written: false, reason: 'unchanged' });
    expect(sent.some((s) => /^\s*update/i.test(s))).toBe(false);
    expect((await row(id))?.updated_at).toBe(first);
  });

  it('an equal hash after a state-only save (stale row) still writes and clears the mark', async () => {
    const id = await newRow();
    const store = createPageStore(db, clock);
    await store.store(id, converted());
    await store.store(id, { kind: 'state-only', state: new Uint8Array([5]), epoch: 0 });
    expect(await store.store(id, converted({ state: new Uint8Array([6])}))).toEqual({ written: true });
    expect(Buffer.from((await row(id))?.ydoc ?? '')).toEqual(Buffer.from([6]));
    expect((await store.load(id))?.markdownStaleSince).toBeNull();
  });

  it('stale mark: state-only sets it once (the earliest time stays), a converted write clears it, listStale returns the stale pages oldest first', async () => {
    const a = await newRow(); const b = await newRow();
    const store = createPageStore(db, clock);
    await store.store(a, converted());
    expect((await store.load(a))?.markdownStaleSince).toBeNull();
    await store.store(a, { kind: 'state-only', state: new Uint8Array([1]), epoch: 0 });
    const first = (await store.load(a))?.markdownStaleSince;
    expect(first).toEqual(expect.any(Number));
    await databaseClockMoves();
    await store.store(b, { kind: 'state-only', state: new Uint8Array([1]), epoch: 0 });
    await store.store(a, { kind: 'state-only', state: new Uint8Array([2]), epoch: 0 });
    expect((await store.load(a))?.markdownStaleSince).toBe(first);
    const ids = (await store.listStale(100)).map((x) => x.id).filter((x) => x === a || x === b);
    expect(ids).toEqual([a, b]);
    await store.store(a, converted({ markdown: 'M2' }));
    expect((await store.load(a))?.markdownStaleSince).toBeNull();
    expect((await store.listStale(100)).map((x) => x.id)).not.toContain(a);
    expect((await store.listStale(100)).find((x) => x.id === b)?.staleSince).toEqual(expect.any(Number));
  });

  it('repairMarkdown writes the Markdown of the state it was made from, and only then', async () => {
    const id = await newRow();
    const store = createPageStore(db, clock);
    await store.store(id, converted({ state: new Uint8Array([1]), markdown: 'old' }));
    await store.store(id, { kind: 'state-only', state: new Uint8Array([2]), epoch: 0 });
    const before = await row(id);
    // A save came in after the state [2] was read: the state is now [3].
    await store.store(id, { kind: 'state-only', state: new Uint8Array([3]), epoch: 0 });
    expect(await store.repairMarkdown(id, { state: new Uint8Array([2]), epoch: 0 }, { markdown: 'from 2', text: 't' })).toBe('skipped');
    expect((await row(id))?.markdown).toBe('old');
    expect(await store.repairMarkdown(id, { state: new Uint8Array([3]), epoch: 1 }, { markdown: 'wrong epoch', text: 't' })).toBe('skipped');
    expect(await store.repairMarkdown(randomUUID(), { state: new Uint8Array([3]), epoch: 0 }, { markdown: 'no row', text: 't' })).toBe('skipped');
    expect(await store.repairMarkdown(id, { state: new Uint8Array([3]), epoch: 0 }, { markdown: 'from 3', text: 'text 3' })).toBe('repaired');
    const after = await row(id);
    expect([after?.markdown, after?.text_content, Buffer.from(after?.ydoc ?? '')]).toEqual(['from 3', 'text 3', Buffer.from([3])]);
    expect(after?.markdown_hash).toEqual(expectedHash('', 'from 3'));
    expect(after?.last_edited_by).toBe(before?.last_edited_by);
    expect((await store.load(id))?.markdownStaleSince).toBeNull();
    expect(await store.repairMarkdown(id, { state: new Uint8Array([3]), epoch: 0 }, { markdown: 'again', text: 't' })).toBe('skipped'); // no longer stale
    const bare = await newRow();
    expect(await store.repairMarkdown(bare, { state: new Uint8Array([1]), epoch: 0 }, { markdown: 'no state', text: 't' })).toBe('skipped');
  });

  it('state-only writes the state and updated_at, never Markdown, text, hash or editor', async () => {
    const id = await newRow();
    const store = createPageStore(db, clock);
    await store.store(id, converted({ editedBy: await newUser() }));
    const before = await row(id);
    await databaseClockMoves();
    expect(await store.store(id, { kind: 'state-only', state: new Uint8Array([4, 4, 4]), epoch: 0 })).toEqual({ written: true });
    const after = await row(id);
    expect(Buffer.from(after?.ydoc ?? '')).toEqual(Buffer.from([4, 4, 4]));
    expect({ ...after, ydoc: null, updated_at: '' }).toEqual({ ...before, ydoc: null, updated_at: '' });
    expect((after?.updated_at ?? '') > (before?.updated_at ?? '')).toBe(true);
  });

  it('epoch-mismatch and no-row write nothing', async () => {
    const id = await newRow();
    await sqlAdmin(DB, `update pages set state_epoch = 3 where id = '${id}'`);
    const store = createPageStore(db, clock);
    expect(await store.store(id, converted({ epoch: 2 }))).toEqual({ written: false, reason: 'epoch-mismatch' });
    expect((await row(id))?.markdown).toBeNull();
    expect(await store.store(randomUUID(), converted())).toEqual({ written: false, reason: 'no-row' });
    expect((await store.load(id))?.epoch).toBe(3);
  });

  it('load returns state, Markdown, hash and epoch; undefined for no row', async () => {
    const id = await newRow();
    const store = createPageStore(db, clock);
    await store.store(id, converted());
    const loaded = await store.load(id);
    expect(loaded?.markdown).toBe('M');
    expect(Buffer.from(loaded?.markdownHash ?? '')).toEqual(expectedHash('', 'M'));
    expect(await store.load(randomUUID())).toBeUndefined();
  });
});

describe('review fixes', () => {
  const same = { kind: 'converted' as const, markdown: 'M', text: 'T', epoch: 0, editedAt: Date.now() };

  it('F7: the same Markdown with a different state writes the state, the time and the editor, not the Markdown columns; an identical state writes nothing', async () => {
    const id = await newRow(); const editor = await newUser();
    const store = createPageStore(db, clock);
    await store.store(id, { ...same, state: new Uint8Array([1]) });
    const first = await row(id);
    await databaseClockMoves();
    expect(await store.store(id, { ...same, state: new Uint8Array([1, 2]), text: 'ignored', editedBy: editor })).toEqual({ written: true });
    const second = await row(id);
    expect(Buffer.from(second?.ydoc ?? '')).toEqual(Buffer.from([1, 2]));
    expect(second).toMatchObject({ markdown: 'M', text_content: 'T', last_edited_by: editor });
    expect((second?.updated_at ?? '') > (first?.updated_at ?? '')).toBe(true);
    await databaseClockMoves();
    expect(await store.store(id, { ...same, state: new Uint8Array([1, 2]) })).toEqual({ written: false, reason: 'unchanged' });
    expect((await row(id))?.updated_at).toBe(second?.updated_at);
  });

  it('F3: 20 heavy first-opens (build takes 400 ms) hold no connection or open transaction while converting, and each row is seeded once', async () => {
    const ids = await Promise.all(Array.from({ length: 20 }, async () => { const id = randomUUID(); await insertPage(run, { id, markdown: 'heavy' }); return id; }));
    // A pool of 2: a connection held during a build would serialise the builds (20 x 400 ms / 2 = 4 s).
    const small = createDatabase(appUrl(DB), { maxConnections: 2 });
    const store = createPageStore(small, clock);
    let idleInTx = 0;
    const sample = async (): Promise<void> => { const r = await sqlAdmin<{ n: string }>(DB, "select count(*) as n from pg_stat_activity where datname = current_database() and usename = 'grimoire_app' and state like 'idle in transaction%'"); idleInTx = Math.max(idleInTx, Number(r[0]?.n)); };
    const t0 = Date.now();
    const builds = new Map<string, number>();
    const results = await Promise.all(ids.flatMap((id) => [0, 1].map(() => store.seed(id, async () => {
      builds.set(id, (builds.get(id) ?? 0) + 1);
      await new Promise((r) => setTimeout(r, 200)); await sample(); await new Promise((r) => setTimeout(r, 200));
      return new Uint8Array([7]);
    }))));
    await small.close();
    expect(idleInTx).toBe(0);
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(results.filter((r) => r.seeded)).toHaveLength(20);
    expect([...builds.values()].every((n) => n === 1)).toBe(true);
  });

  it('F3: a row whose Markdown changed while it was converted is not written with the old result', async () => {
    const id = randomUUID();
    await insertPage(run, { id, markdown: 'old' });
    const seen: string[] = [];
    const r = await createPageStore(db, clock).seed(id, async (md) => {
      seen.push(md);
      if (md === 'old') await sqlAdmin(DB, `update pages set markdown = 'new' where id = '${id}'`);
      return new TextEncoder().encode(md);
    });
    expect(seen).toEqual(['old', 'new']);
    expect(Buffer.from(r.state ?? '').toString()).toBe('new');
    expect(Buffer.from((await row(id))?.ydoc ?? '').toString()).toBe('new');
  });
});
