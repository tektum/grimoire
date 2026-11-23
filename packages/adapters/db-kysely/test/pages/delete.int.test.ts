import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  collection = (await createCollections(t.app).append({ name: 'del', createdBy: user }, (last) => ordering.between(last, null))).id;
}, 60_000);
afterAll(async () => { await t?.drop(); });

describe('the PostgreSQL PageRepo softDelete', () => {
  it('stamps the page and every live descendant with the page id as the batch, deletes no row, and keeps an earlier batch', async () => {
    const top = await make();
    const kid = await make(top);
    const grandkid = await make(kid);
    const earlier = await make(top);
    const sibling = await make();
    expect(await pages().softDelete(earlier, user)).toBe(1);
    const before = Number((await t.admin.query<{ n: string }>(`select count(*) as n from pages`))[0]?.n);

    expect(await pages().softDelete(top, user)).toBe(3);
    for (const id of [top, kid, grandkid]) expect(await row(id)).toMatchObject({ deleted_batch: top, deleted_by: user });
    expect((await row(earlier))?.deleted_batch).toBe(earlier);
    expect((await row(sibling))?.deleted_at).toBeNull();
    expect(Number((await t.admin.query<{ n: string }>(`select count(*) as n from pages`))[0]?.n)).toBe(before);
    expect((await t.admin.query<{ id: string }>(`select id from pages where collection_id = $1 and deleted_at is null`, [collection])).map((r) => r.id)).toContain(sibling);
    expect(await pages().get(kid)).toBeUndefined();
  });

  it('is undefined for a page that is already deleted, unknown, or in a deleted collection', async () => {
    const page = await make();
    await pages().softDelete(page, user);
    expect(await pages().softDelete(page, user)).toBeUndefined();
    expect(await pages().softDelete('00000000-0000-4000-8000-000000000000', user)).toBeUndefined();
    const other = (await createCollections(t.app).append({ name: 'del2', createdBy: user }, (last) => ordering.between(last, null))).id;
    const inside = await pages().create({ collectionId: other, parentId: null, afterId: null, title: 'In', createdBy: user }, limits, (a, b) => ordering.between(a, b));
    if (inside.kind !== 'created') throw new Error(inside.kind);
    await createCollections(t.app).softDelete(other, user);
    expect(await pages().softDelete(inside.page.id, user)).toBeUndefined();
  });
});
