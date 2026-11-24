import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PageLimits } from '@tektum/grimoire-core/ports/page-repo';
import { FakeOrdering } from '@tektum/grimoire-core/testing/fake-position';
import { createCollections } from '../../src/collections.js';
import { createPages } from '../../src/pages.js';
import { addUser, createTestDatabase } from '../collections/support.js';
import type { TestDatabase } from '../collections/support.js';

let t: TestDatabase;
let user: string;
let collection: string;
const ordering = new FakeOrdering();
const limits: PageLimits = { maxDepth: 32, maxPages: 10_000 };
const pages = () => createPages(t.app);
const make = async (parentId: string | null = null): Promise<string> => {
  const r = await pages().create({ collectionId: collection, parentId, afterId: null, title: 'P', createdBy: user }, limits, (a, b) => ordering.between(a, b));
  if (r.kind !== 'created') throw new Error(r.kind);
  return r.page.id;
};
const row = async (id: string) => (await t.admin.query<{ deleted_at: Date | null; deleted_by: string | null; deleted_batch: string | null }>(
  `select deleted_at, deleted_by, deleted_batch from pages where id = $1`, [id]))[0];

beforeAll(async () => {
  t = await createTestDatabase('pdelete');
  user = await addUser(t.app, 'ada', 'admin');
  collection = (await createCollections(t.app).append('legacy', { name: 'del', createdBy: user }, (last) => ordering.between(last, null))).id;
}, 60_000);
afterAll(async () => { await t?.drop(); });

describe('the PostgreSQL PageRepo softDelete', () => {
  it('stamps the page and every live descendant with the page id as the batch, deletes no row, and keeps an earlier batch', async () => {
    const top = await make();
    const kid = await make(top);
    const grandkid = await make(kid);
    const earlier = await make(top);
    const sibling = await make();
    expect(await pages().softDelete(earlier, user, collection)).toEqual({ kind: 'deleted', pages: 1 });
    const before = Number((await t.admin.query<{ n: string }>(`select count(*) as n from pages`))[0]?.n);

    expect(await pages().softDelete(top, user, collection)).toEqual({ kind: 'deleted', pages: 3 });
    for (const id of [top, kid, grandkid]) expect(await row(id)).toMatchObject({ deleted_batch: top, deleted_by: user });
    expect((await row(earlier))?.deleted_batch).toBe(earlier);
    expect((await row(sibling))?.deleted_at).toBeNull();
    expect(Number((await t.admin.query<{ n: string }>(`select count(*) as n from pages`))[0]?.n)).toBe(before);
    expect((await t.admin.query<{ id: string }>(`select id from pages where collection_id = $1 and deleted_at is null`, [collection])).map((r) => r.id)).toContain(sibling);
    expect(await pages().get(kid)).toBeUndefined();
  });

  it('is not-found for a page that is already deleted, unknown, or in a deleted collection', async () => {
    const page = await make();
    await pages().softDelete(page, user, collection);
    expect(await pages().softDelete(page, user, collection)).toEqual({ kind: 'not-found' });
    expect(await pages().softDelete('00000000-0000-4000-8000-000000000000', user, collection)).toEqual({ kind: 'not-found' });
    const other = (await createCollections(t.app).append('legacy', { name: 'del2', createdBy: user }, (last) => ordering.between(last, null))).id;
    const inside = await pages().create({ collectionId: other, parentId: null, afterId: null, title: 'In', createdBy: user }, limits, (a, b) => ordering.between(a, b));
    if (inside.kind !== 'created') throw new Error(inside.kind);
    await createCollections(t.app).softDelete('legacy', other, user);
    expect(await pages().softDelete(inside.page.id, user, other)).toEqual({ kind: 'not-found' });
  });

  it('deletes nothing when the page is not in the collection the caller was checked against', async () => {
    const elsewhere = (await createCollections(t.app).append('legacy', { name: 'del3', createdBy: user }, (last) => ordering.between(last, null))).id;
    const page = await make();
    const kid = await make(page);
    expect(await pages().softDelete(page, user, elsewhere)).toEqual({ kind: 'conflict' });
    expect([(await row(page))?.deleted_at, (await row(kid))?.deleted_at]).toEqual([null, null]);
  });

  it('answers not-found, not conflict, for a page another request deleted while this one waited for the collection lock', async () => {
    const page = await make();
    let release!: () => void;
    let held!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const locked = new Promise<void>((resolve) => { held = resolve; });
    // Another transaction holds the collection and deletes the page; the delete is started meanwhile and queues behind it.
    const first = t.app.transaction(async (tx) => {
      await tx.query(`select 1 from collections where id = $1 for update`, [collection]);
      held();
      await gate;
      await tx.query(`update pages set deleted_at = now(), deleted_by = $2, deleted_batch = $1 where id = $1`, [page, user]);
    });
    await locked;
    const second = pages().softDelete(page, user, collection);
    await vi.waitFor(async () => {
      const waiting = await t.app.query<{ n: string }>(`select count(*) as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`);
      expect(Number(waiting[0]?.n)).toBe(1);
    });
    release();
    await first;
    expect(await second).toEqual({ kind: 'not-found' });
  });
});
