import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { purgeBatch } from '@tektum/grimoire-core/pages/purge';
import type { PageLimits } from '@tektum/grimoire-core/ports/page-repo';
import { FakeOrdering } from '@tektum/grimoire-core/testing/fake-position';
import { createCollections } from '../../src/collections.js';
import { createPages } from '../../src/pages.js';
import { createTrash } from '../../src/trash.js';
import { addUser, createTestDatabase } from '../collections/support.js';
import type { TestDatabase } from '../collections/support.js';

let t: TestDatabase;
let user: string;
let collection: string;
const ordering = new FakeOrdering();
const limits: PageLimits = { maxDepth: 32, maxPages: 10_000 };
const pages = () => createPages(t.app);
const trash = () => createTrash(t.app);
const place = (before: string | null, after: string | null) => ordering.between(before, after);

async function newCollection(name: string): Promise<string> {
  return (await createCollections(t.app).append({ name, createdBy: user }, (last) => ordering.between(last, null))).id;
}
async function make(title: string, parentId: string | null = null, collectionId = collection): Promise<string> {
  const r = await pages().create({ collectionId, parentId, afterId: null, title, createdBy: user }, limits, place);
  if (r.kind !== 'created') throw new Error(r.kind);
  return r.page.id;
}
const remove = (id: string, collectionId = collection) => pages().softDelete(id, user, collectionId);
const state = async (id: string): Promise<string> => {
  const rows = await t.admin.query<{ deleted_at: Date | null; deleted_batch: string | null }>(`select deleted_at, deleted_batch from pages where id = $1`, [id]);
  return rows[0] === undefined ? 'gone' : rows[0].deleted_at === null ? 'live' : 'deleted';
};
const count = async (sql: string, id: string): Promise<number> => Number((await t.admin.query<{ n: string }>(sql, [id]))[0]?.n);

beforeAll(async () => {
  t = await createTestDatabase('trash');
  user = await addUser(t.app, 'ada', 'admin');
}, 60_000);
beforeEach(async () => {
  collection = await newCollection(`c-${String(Math.random()).slice(2)}`);
});
afterAll(async () => {
  await t?.drop();
});

describe('TrashRepo.roots and rootOf', () => {
  it('lists one root per batch and not its descendants, newest first, with who deleted it', async () => {
    const root = await make('root');
    const child = await make('child', root);
    const grandchild = await make('grandchild', child);
    const other = await make('other');
    await remove(root);
    await t.admin.query(`update pages set deleted_at = deleted_at - interval '1 minute' where id = $1`, [root]); // two distinct deletion times, so the order is the time and not the id
    await remove(other);
    const roots = (await trash().roots([collection], 10)).map((r) => r.id);
    expect(roots).toEqual([other, root]);
    expect(roots).not.toContain(child);
    expect(roots).not.toContain(grandchild);
    expect((await trash().roots([collection], 10))[0]).toMatchObject({ title: 'other', collectionId: collection, deletedBy: user });
  });

  it('counts a page deleted on its own earlier as a root of its own batch, under a parent deleted later', async () => {
    const parent = await make('parent');
    const child = await make('child', parent);
    await remove(child);
    await remove(parent);
    const roots = (await trash().roots([collection], 10)).map((r) => r.id);
    expect(roots.sort()).toEqual([parent, child].sort());
  });

  it('keeps to the collections asked for, takes a keyset cursor and a limit, and sees them all for null', async () => {
    const other = await newCollection('other');
    const a = await make('a');
    const b = await make('b');
    const c = await make('c', null, other);
    await remove(a);
    await remove(b);
    await remove(c, other);
    expect((await trash().roots([collection], 10)).map((r) => r.id).sort()).toEqual([a, b].sort());
    const everything = (await trash().roots(null, 100)).map((r) => r.id);
    expect(everything).toEqual(expect.arrayContaining([a, b, c]));
    const first = await trash().roots([collection], 1);
    expect(first).toHaveLength(1);
    const next = await trash().roots([collection], 1, { deletedAt: first[0]?.deletedAt as number, id: first[0]?.id as string });
    expect([...first, ...next].map((r) => r.id).sort()).toEqual([a, b].sort());
    expect(await trash().roots([], 10)).toEqual([]);
  });

  it('answers rootOf for a root only, with its batch and whether the collection is deleted', async () => {
    const root = await make('root');
    const child = await make('child', root);
    const live = await make('live');
    await remove(root);
    expect(await trash().rootOf(root)).toEqual({ id: root, collectionId: collection, batch: root, collectionDeleted: false });
    expect(await trash().rootOf(child)).toBeUndefined();
    expect(await trash().rootOf(live)).toBeUndefined();
    expect(await trash().rootOf('00000000-0000-4000-8000-000000000999')).toBeUndefined();
    await createCollections(t.app).softDelete(collection, user);
    expect((await trash().rootOf(live))?.collectionDeleted).toBe(true);
  });
});

describe('TrashRepo.restore', () => {
  it('restores the whole batch, and leaves a descendant deleted earlier in the trash', async () => {
    const root = await make('root');
    const child = await make('child', root);
    const early = await make('early', child);
    const late = await make('late', root);
    await remove(early);
    await remove(root);
    const out = await trash().restore(root, collection, limits, place);
    expect(out.kind).toBe('restored');
    expect(await Promise.all([root, child, late, early].map(state))).toEqual(['live', 'live', 'live', 'deleted']);
    expect(
      Number(
        (
          await t.admin.query<{ n: string }>(`select count(*) as n from pages where id = any($1::uuid[]) and (deleted_batch is not null or deleted_by is not null or deleted_at is not null)`, [
            [root, child, late],
          ])
        )[0]?.n,
      ),
    ).toBe(0);
  });

  it('puts a root whose parent was deleted at the top level, before the first live top-level page', async () => {
    const a = await make('a');
    await make('b');
    const parent = await make('parent');
    const root = await make('root', parent);
    await remove(root);
    await remove(parent);
    const out = await trash().restore(root, collection, limits, place);
    if (out.kind !== 'restored') throw new Error(out.kind);
    expect(out.page.parentId).toBeNull();
    const first = (await pages().get(a))?.position as string;
    expect(out.page.position < first).toBe(true);
    const tops = await t.admin.query<{ id: string }>(`select id from pages where collection_id = $1 and parent_id is null and deleted_at is null order by position`, [collection]);
    expect(tops[0]?.id).toBe(root);
  });

  it('keeps a live parent and the old place, and the last place when a live page has taken it', async () => {
    const parent = await make('parent');
    const free = await make('free', parent);
    await remove(free);
    const kept = await trash().restore(free, collection, limits, place);
    if (kept.kind !== 'restored') throw new Error(kept.kind);
    expect(kept.page.parentId).toBe(parent);
    const taken = await make('taken', parent);
    const position = (await pages().get(taken))?.position as string;
    await remove(taken);
    const clash = await make('clash', parent);
    await t.admin.query(`update pages set position = $2 where id = $1`, [clash, position]);
    const moved = await trash().restore(taken, collection, limits, place);
    if (moved.kind !== 'restored') throw new Error(moved.kind);
    expect(moved.page.parentId).toBe(parent);
    expect(moved.page.position > position).toBe(true);
  });

  it('keeps the place of a top-level root when it is free, and goes last when a live page took it', async () => {
    const first = await make('first');
    const second = await make('second');
    await remove(second);
    const kept = await trash().restore(second, collection, limits, place);
    if (kept.kind !== 'restored') throw new Error(kept.kind);
    const order = await t.admin.query<{ id: string }>(`select id from pages where collection_id = $1 and deleted_at is null order by position`, [collection]);
    expect(order.map((r) => r.id)).toEqual([first, second]);
    const position = (await pages().get(second))?.position as string;
    await remove(second);
    const clash = await make('clash');
    await t.admin.query(`update pages set position = $2 where id = $1`, [clash, position]);
    const moved = await trash().restore(second, collection, limits, place);
    if (moved.kind !== 'restored') throw new Error(moved.kind);
    expect(moved.page.parentId).toBeNull();
    expect(moved.page.position > position).toBe(true);
  });

  it('sends a root to the top level when under its live parent the batch would be deeper than allowed', async () => {
    const top = await make('top');
    const mid = await make('mid', top);
    const root = await make('root', mid);
    await make('leaf', root);
    await remove(root);
    const tight = { maxDepth: 4, maxPages: 10_000 };
    const out = await trash().restore(root, collection, tight, place);
    if (out.kind !== 'restored') throw new Error(out.kind);
    expect(out.page.parentId).toBeNull();
    const fits = await make('fits', mid);
    await make('fits-leaf', fits);
    await remove(fits);
    const ok = await trash().restore(fits, collection, tight, place);
    if (ok.kind !== 'restored') throw new Error(ok.kind);
    expect(ok.page.parentId).toBe(mid);
  });

  it('restores nothing when the page is in another collection than the one that was checked', async () => {
    const root = await make('root');
    const child = await make('child', root);
    await remove(root);
    const elsewhere = await newCollection('elsewhere');
    expect((await trash().restore(root, elsewhere, limits, place)).kind).toBe('conflict');
    expect(await Promise.all([root, child].map(state))).toEqual(['deleted', 'deleted']);
  });

  it('is collection-deleted for a deleted collection, collection-full over the limit, and not-found for anything that is not a root', async () => {
    const root = await make('root');
    const child = await make('child', root);
    await remove(root);
    expect((await trash().restore(root, collection, { maxDepth: 32, maxPages: 1 }, place)).kind).toBe('collection-full');
    expect(await state(root)).toBe('deleted');
    expect((await trash().restore(child, collection, limits, place)).kind).toBe('not-found');
    expect((await trash().restore('00000000-0000-4000-8000-000000000999', collection, limits, place)).kind).toBe('not-found');
    await createCollections(t.app).softDelete(collection, user);
    expect((await trash().restore(root, collection, limits, place)).kind).toBe('collection-deleted');
    expect(await state(root)).toBe('deleted');
  });

  it('counts the live pages and the batch together against the limit, and only the pages of this collection', async () => {
    const root = await make('root');
    await make('child', root);
    await remove(root);
    await make('live');
    const other = await newCollection('elsewhere');
    await make('x', null, other);
    expect((await trash().restore(root, collection, { maxDepth: 32, maxPages: 3 }, place)).kind).toBe('restored');
    const again = await make('r2');
    await remove(again);
    expect((await trash().restore(again, collection, { maxDepth: 32, maxPages: 3 }, place)).kind).toBe('collection-full');
  });
});

describe('TrashRepo.purge and purgeBatch', () => {
  async function batchWithFiles(): Promise<{ root: string; child: string; other: string }> {
    const root = await make('root');
    const child = await make('child', root);
    const other = await make('other');
    await t.admin.query(`insert into revisions (page_id, title, markdown, markdown_hash, reason, created_at) values ($1, 't', 'm', decode(repeat('00', 32), 'hex'), 'manual', now())`, [child]);
    await t.admin.query(
      `insert into attachments (page_id, file_name, content_type, size, s3_key, status) values ($1, 'a.png', 'image/png', 3, $2, 'ready'), ($3, 'b.png', 'image/png', 3, $4, 'ready')`,
      [child, `attachments/${child}/1/a.png`, other, `attachments/${other}/1/b.png`],
    );
    await remove(root);
    await remove(other);
    return { root, child, other };
  }

  it('deletes the batch rows in one statement with their revisions and attachment rows, writes one audit row, and leaves other batches', async () => {
    const { root, child, other } = await batchWithFiles();
    expect(await trash().attachmentKeys(root)).toEqual([`attachments/${child}/1/a.png`]);
    expect(await trash().purge(root, user, [`attachments/${child}/1/a.png`])).toEqual({ pages: 2 });
    expect(await Promise.all([root, child, other].map(state))).toEqual(['gone', 'gone', 'deleted']);
    expect(await count(`select count(*) as n from revisions where page_id = $1`, child)).toBe(0);
    expect(await count(`select count(*) as n from attachments where page_id = $1`, child)).toBe(0);
    expect(await count(`select count(*) as n from attachments where page_id = $1`, other)).toBe(1);
    const audit = await t.admin.query<{ actor_id: string; action: string; target_type: string; target_id: string; detail: { batch: string; pages: number } }>(
      `select actor_id, action, target_type, target_id, detail from audit_events where action = 'page.purged' and target_id = $1`,
      [root],
    );
    expect(audit).toEqual([{ actor_id: user, action: 'page.purged', target_type: 'page', target_id: root, detail: { batch: root, pages: 2 } }]);
  });

  it('is a no-op for a batch already gone: nothing deleted, no second audit row', async () => {
    const { root } = await batchWithFiles();
    await trash().purge(root, user, []);
    expect(await trash().purge(root, user, [])).toEqual({ pages: 0 });
    expect(await count(`select count(*) as n from audit_events where action = 'page.purged' and target_id = $1`, root)).toBe(1);
  });

  it('asks for the files first, and leaves every row and writes nothing when that fails', async () => {
    const { root, child } = await batchWithFiles();
    const seen: (readonly string[])[] = [];
    await expect(
      purgeBatch(
        {
          trash: trash(),
          deleteFiles: (keys) => {
            seen.push(keys);
            return Promise.reject(new Error('store down'));
          },
        },
        root,
        user,
      ),
    ).rejects.toThrow('store down');
    expect(seen).toEqual([[`attachments/${child}/1/a.png`]]);
    expect(await Promise.all([root, child].map(state))).toEqual(['deleted', 'deleted']);
    expect(await count(`select count(*) as n from attachments where page_id = $1`, child)).toBe(1);
    expect(await count(`select count(*) as n from audit_events where action = 'page.purged' and target_id = $1`, root)).toBe(0);
    expect(await purgeBatch({ trash: trash(), deleteFiles: () => Promise.resolve() }, root, user)).toEqual({ pages: 2, files: 1 });
  });

  it('takes with it a page below the batch that was deleted earlier, and its files, instead of failing on the parent link', async () => {
    const parent = await make('parent');
    const early = await make('early', parent);
    await t.admin.query(`insert into attachments (page_id, file_name, content_type, size, s3_key, status) values ($1, 'e.png', 'image/png', 3, $2, 'ready')`, [early, `attachments/${early}/1/e.png`]);
    await remove(early);
    await remove(parent);
    expect(await trash().attachmentKeys(parent)).toEqual([`attachments/${early}/1/e.png`]);
    expect(await trash().purge(parent, user, [`attachments/${early}/1/e.png`])).toEqual({ pages: 2 });
    expect(await Promise.all([parent, early].map(state))).toEqual(['gone', 'gone']);
  });

  it('marks the attachments whose page was restored in between as deleted, and writes no audit row', async () => {
    const root = await make('root');
    const key = `attachments/${root}/1/r.png`;
    await t.admin.query(`insert into attachments (page_id, file_name, content_type, size, s3_key, status) values ($1, 'r.png', 'image/png', 3, $2, 'ready')`, [root, key]);
    await remove(root);
    const keys = await trash().attachmentKeys(root);
    expect((await trash().restore(root, collection, limits, place)).kind).toBe('restored');
    expect(await trash().purge(root, user, keys)).toEqual({ pages: 0 });
    expect(await state(root)).toBe('live');
    expect(await count(`select count(*) as n from attachments where page_id = $1 and deleted_at is not null`, root)).toBe(1);
    expect(await count(`select count(*) as n from audit_events where action = 'page.purged' and target_id = $1`, root)).toBe(0);
  });

  it('removes the pages of a deleted collection by their shared batch', async () => {
    const a = await make('a');
    const b = await make('b');
    await createCollections(t.app).softDelete(collection, user);
    const info = await trash().rootOf(a);
    expect(info?.batch).toBeDefined();
    expect(info?.batch).not.toBe(a);
    expect(await trash().purge(info?.batch as string, user, [])).toEqual({ pages: 2 });
    expect(await Promise.all([a, b].map(state))).toEqual(['gone', 'gone']);
  });
});
