import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MovePageResult, PageLimits } from '@tektum/grimoire-core/ports/page-repo';
import { FakeOrdering } from '@tektum/grimoire-core/testing/fake-position';
import { createCollections } from '../../src/collections.js';
import { createPages } from '../../src/pages.js';
import type { KyselyDatabase } from '../../src/index.js';
import { addUser, createTestDatabase } from '../collections/support.js';
import type { TestDatabase } from '../collections/support.js';

let t: TestDatabase;
let user: string;
const ordering = new FakeOrdering();
const between = (a: string | null, b: string | null): string => ordering.between(a, b);
const limits: PageLimits = { maxDepth: 32, maxPages: 10_000 };
const pages = () => createPages(t.app);
const newCollection = async (name: string): Promise<string> => (await createCollections(t.app).append({ name, createdBy: user }, (last) => ordering.between(last, null))).id;
const make = async (collectionId: string, parentId: string | null = null): Promise<string> => {
  const r = await pages().create({ collectionId, parentId, afterId: null, title: 'P', createdBy: user }, limits, between);
  if (r.kind !== 'created') throw new Error(r.kind);
  return r.page.id;
};
const move = async (id: string, to: { collectionId?: string; parentId?: string | null; afterId?: string | null; expected?: string }, l: PageLimits = limits, repo = pages()): Promise<MovePageResult> =>
  repo.move(id, { expectedCollectionId: to.expected ?? (await row(id))?.collection_id ?? '00000000-0000-4000-8000-000000000000', collectionId: to.collectionId ?? null, parentId: to.parentId ?? null, afterId: to.afterId ?? null }, l, between);
const row = async (id: string) => (await t.admin.query<{ collection_id: string; parent_id: string | null; position: string; deleted_at: Date | null }>(
  `select collection_id, parent_id, position, deleted_at from pages where id = $1`, [id]))[0];
/** A database whose transactions are aborted the first `failures` times, as serialization failures are. */
const flaky = (d: KyselyDatabase, failures: number): { db: KyselyDatabase; attempts: () => number } => {
  let attempts = 0;
  return {
    attempts: () => attempts,
    db: { ...d, transaction: (fn) => { attempts += 1; return attempts <= failures ? Promise.reject(Object.assign(new Error('could not serialize'), { code: '40001' })) : d.transaction(fn); } },
  };
};

beforeAll(async () => {
  t = await createTestDatabase('move');
  user = await addUser(t.app, 'ada', 'admin');
}, 60_000);
afterAll(async () => { await t?.drop(); });

describe('the PostgreSQL PageRepo move', () => {
  it('moves a page under a parent, after a sibling and to the top level, among siblings in order', async () => {
    const c = await newCollection('basic');
    const a = await make(c);
    const b = await make(c);
    const d = await make(c);
    const under = await move(d, { parentId: a });
    expect(under.kind === 'moved' && under.page.parentId).toBe(a);
    const after = await move(d, { afterId: a });
    expect(after.kind).toBe('moved');
    const [ra, rb, rd] = await Promise.all([row(a), row(b), row(d)]);
    expect(ra && rd && rb && ra.position < rd.position && rd.position < rb.position).toBe(true);
    expect(rd?.parent_id).toBeNull();
    expect(await move(a, { afterId: a })).toEqual({ kind: 'no-after' });
    expect(await move(a, { parentId: '00000000-0000-4000-8000-000000000000' })).toEqual({ kind: 'no-parent' });
    expect(await move('00000000-0000-4000-8000-000000000000', {})).toEqual({ kind: 'not-found' });
  });

  it('refuses a page under itself or its own child with would-create-cycle and changes nothing', async () => {
    const c = await newCollection('cycle');
    const a = await make(c);
    const child = await make(c, a);
    const leaf = await make(c, child);
    const before = await row(a);
    for (const target of [a, child, leaf]) expect(await move(a, { parentId: target })).toEqual({ kind: 'would-create-cycle' });
    expect(await row(a)).toEqual(before);
  });

  it('leaves exactly one success and an acyclic tree for two concurrent moves, A under B and B under A', async () => {
    const c = await newCollection('race');
    const a = await make(c);
    const b = await make(c);
    const results = await Promise.all([move(a, { parentId: b }), move(b, { parentId: a })]);
    expect(results.map((r) => r.kind).sort()).toEqual(['moved', 'would-create-cycle']);
    const [ra, rb] = await Promise.all([row(a), row(b)]);
    expect([ra?.parent_id === b, rb?.parent_id === a].filter(Boolean)).toHaveLength(1);
  });

  it('counts the whole moved subtree against the depth', async () => {
    const c = await newCollection('depth');
    let parent: string | undefined;
    for (let level = 1; level <= 3; level += 1) parent = await make(c, parent ?? null);
    const leaf = await make(c);
    const branch = await make(c);
    await make(c, branch);
    const small: PageLimits = { maxDepth: 4, maxPages: 100 };
    expect((await move(leaf, { parentId: parent as string }, small)).kind).toBe('moved');
    expect(await move(branch, { parentId: parent as string }, small)).toEqual({ kind: 'too-deep' });
  });

  it('moves a subtree to another collection in one transaction, deleted descendants included, with every parent link valid', async () => {
    const from = await newCollection('from');
    const to = await newCollection('to');
    const top = await make(from);
    const kid = await make(from, top);
    const grandkid = await make(from, kid);
    const gone = await make(from, top);
    await t.admin.query(`update pages set deleted_at = now(), deleted_batch = gen_random_uuid() where id = $1`, [gone]);
    const outside = await make(from);
    const result = await move(top, { collectionId: to });
    expect(result.kind).toBe('moved');
    for (const id of [top, kid, grandkid, gone]) expect((await row(id))?.collection_id).toBe(to);
    expect((await row(outside))?.collection_id).toBe(from);
    const links = await t.admin.query<{ n: string }>(
      `select count(*) as n from pages c join pages p on p.id = c.parent_id where p.collection_id <> c.collection_id`);
    expect(Number(links[0]?.n)).toBe(0);
    expect((await row(gone))?.deleted_at).not.toBeNull();
  });

  it('moves nothing when the page left the collection the caller was checked against', async () => {
    const s = await newCollection('was');
    const other = await newCollection('now');
    const third = await newCollection('third');
    const page = await make(s);
    await move(page, { collectionId: other });
    expect(await move(page, { expected: s, collectionId: third })).toEqual({ kind: 'conflict' });
    expect(await move(page, { expected: s })).toEqual({ kind: 'conflict' });
    expect((await row(page))?.collection_id).toBe(other);
    expect((await move(page, { expected: other, collectionId: third })).kind).toBe('moved');
  });

  it('refuses a move into a deleted collection, and a page of a deleted collection', async () => {
    const live = await newCollection('live');
    const dead = await newCollection('dead');
    const page = await make(live);
    const inDead = await make(dead);
    await createCollections(t.app).softDelete(dead, user);
    expect(await move(page, { collectionId: dead })).toEqual({ kind: 'collection-deleted' });
    expect(await move(inDead, {})).toEqual({ kind: 'not-found' });
    expect((await row(page))?.collection_id).toBe(live);
  });

  it('refuses the move that takes the target collection above its limit, counting the subtree', async () => {
    const from = await newCollection('cap-from');
    const to = await newCollection('cap-to');
    const top = await make(from);
    await make(from, top);
    await t.admin.query(`insert into pages (collection_id, created_by, position) select $1, $2, 'b' || lpad(g::text, 6, '0') from generate_series(1, 9999) g`, [to, user]);
    expect(await move(top, { collectionId: to })).toEqual({ kind: 'collection-full' });
    expect((await row(top))?.collection_id).toBe(from);
    const single = await make(from);
    expect((await move(single, { collectionId: to })).kind).toBe('moved');
  });

  it('retries a transaction the database aborted, up to three attempts, then reports a conflict', async () => {
    const c = await newCollection('retry');
    const a = await make(c);
    const recovers = flaky(t.app, 2);
    expect((await move(a, {}, limits, createPages(recovers.db))).kind).toBe('moved');
    expect(recovers.attempts()).toBe(3);
    const gives = flaky(t.app, 99);
    expect(await move(a, {}, limits, createPages(gives.db))).toEqual({ kind: 'conflict' });
    expect(gives.attempts()).toBe(3);
  });
});
