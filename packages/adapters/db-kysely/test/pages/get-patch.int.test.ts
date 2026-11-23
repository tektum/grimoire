import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@tektum/grimoire-core/ports/database';
import { markdownHash } from '@tektum/grimoire-core/pages/hash';
import { isSeedRefusal, seedUserMarkdown } from '@tektum/grimoire-core/pages/seeded-content';
import type { PageLimits } from '@tektum/grimoire-core/ports/page-repo';
import { FakeMarkdownConverter } from '@tektum/grimoire-core/testing/fake-markdown-converter';
import { FakeOrdering } from '@tektum/grimoire-core/testing/fake-position';
import { createCollections } from '../../src/collections.js';
import { createPages } from '../../src/pages.js';
import { createPageStore } from '../../src/page-store.js';
import type { KyselyDatabase } from '../../src/index.js';
import { addUser, createTestDatabase } from '../collections/support.js';
import type { TestDatabase } from '../collections/support.js';

let t: TestDatabase;
let user: string;
let collection: string;
const ordering = new FakeOrdering();
const limits: PageLimits = { maxDepth: 32, maxPages: 10_000 };
const pages = () => createPages(t.app);
const make = async (title: string, parentId: string | null = null, content?: Awaited<ReturnType<typeof seeded>>): Promise<string> => {
  const r = await pages().create({ collectionId: collection, parentId, afterId: null, title, createdBy: user, content }, limits, (a, b) => ordering.between(a, b));
  if (r.kind !== 'created') throw new Error(r.kind);
  return r.page.id;
};
const seeded = async (markdown: string, title: string) => {
  const converter = new FakeMarkdownConverter({ seed: { ok: true, state: new Uint8Array([1, 2, 3]) }, convert: { ok: true, markdown, text: markdown } });
  const out = await seedUserMarkdown(converter, user, title, markdown);
  if (isSeedRefusal(out)) throw new Error('refused');
  return out;
};
/** A database that records every statement sent, in or out of a transaction. */
const counted = (d: KyselyDatabase, sent: string[]): Database => ({
  query: (sql, params) => { sent.push(sql); return d.query(sql, params); },
  transaction: (fn) => d.transaction((tx) => fn({ query: (sql, params) => { sent.push(sql); return tx.query(sql, params); } })),
  ping: () => d.ping(),
  close: () => d.close(),
});

beforeAll(async () => {
  t = await createTestDatabase('getpatch');
  user = await addUser(t.app, 'ada', 'admin');
  collection = (await createCollections(t.app).append({ name: 'gp', createdBy: user }, (last) => ordering.between(last, null))).id;
}, 60_000);
afterAll(async () => { await t?.drop(); });

describe('the PostgreSQL PageRepo get', () => {
  it('returns the page with its ancestors root first, and none for a top-level page', async () => {
    const root = await make('Root');
    const mid = await make('Mid', root);
    const leaf = await make('Leaf', mid);
    const page = await pages().get(leaf);
    expect(page?.breadcrumb).toEqual([{ id: root, title: 'Root' }, { id: mid, title: 'Mid' }]);
    expect(page).toMatchObject({ id: leaf, parentId: mid, collectionId: collection, title: 'Leaf', createdBy: user, lastEditedBy: null, lastEditedAt: null, stateEpoch: 0, markdownStaleSince: null });
    expect((await pages().get(root))?.breadcrumb).toEqual([]);
    expect(typeof page?.savedAt).toBe('number');
    expect(await pages().get('00000000-0000-4000-8000-000000000000')).toBeUndefined();
  });

  it('reports when the Markdown fell behind the state, and is none for a deleted page or a page of a deleted collection', async () => {
    const id = await make('Stale');
    await t.admin.query(`update pages set markdown_stale_since = to_timestamp(1700000000) where id = $1`, [id]);
    expect((await pages().get(id))?.markdownStaleSince).toBe(1_700_000_000_000);
    await t.admin.query(`update pages set deleted_at = now() where id = $1`, [id]);
    expect(await pages().get(id)).toBeUndefined();
    const other = (await createCollections(t.app).append({ name: 'gp-del', createdBy: user }, (last) => ordering.between(last, null))).id;
    const inside = (await pages().create({ collectionId: other, parentId: null, afterId: null, title: 'In', createdBy: user }, limits, (a, b) => ordering.between(a, b)));
    if (inside.kind !== 'created') throw new Error(inside.kind);
    await createCollections(t.app).softDelete(other, user);
    expect(await pages().get(inside.page.id)).toBeUndefined();
  });

  it('finds the id of a page by its URL id, deleted or not', async () => {
    const id = await make('ByUrl');
    const urlId = (await pages().get(id))?.urlId as string;
    expect(await pages().idOfUrlId(urlId)).toBe(id);
    await t.admin.query(`update pages set deleted_at = now() where id = $1`, [id]);
    expect(await pages().idOfUrlId(urlId)).toBe(id);
    expect(await pages().idOfUrlId('no-such-url-id')).toBeUndefined();
  });
});

describe('the PostgreSQL PageRepo updateMeta', () => {
  it('changes the title and the icon, clears the icon with null, and leaves what was not sent', async () => {
    const id = await make('Old');
    expect((await pages().updateMeta(id, { title: 'New', icon: 'star' }))).toMatchObject({ title: 'New', icon: 'star' });
    expect((await pages().updateMeta(id, { icon: null }))).toMatchObject({ title: 'New', icon: null });
    expect((await pages().updateMeta(id, { title: 'Newer' }))).toMatchObject({ title: 'Newer', icon: null });
  });

  it('moves the hash with the title, and a following editor save with the same Markdown writes nothing', async () => {
    const id = await make('Old', null, await seeded('canonical', 'Old'));
    await pages().updateMeta(id, { title: 'New' });
    const hash = (await t.admin.query<{ markdown_hash: Buffer }>(`select markdown_hash from pages where id = $1`, [id]))[0]?.markdown_hash;
    expect(hash?.equals(markdownHash('New', 'canonical'))).toBe(true);
    const sent: string[] = [];
    const store = createPageStore(counted(t.app, sent), { now: () => Date.now() });
    const outcome = await store.store(id, { kind: 'converted', state: new Uint8Array([1, 2, 3]), markdown: 'canonical', text: 'canonical', epoch: 0, editedAt: Date.now() });
    expect(outcome).toEqual({ written: false, reason: 'unchanged' });
    expect(sent.some((s) => /^\s*update/i.test(s))).toBe(false);
  });

  it('keeps a page without Markdown without a hash, and does not touch a deleted page', async () => {
    const id = await make('Bare');
    await pages().updateMeta(id, { title: 'Bare2' });
    expect((await t.admin.query<{ markdown_hash: Buffer | null }>(`select markdown_hash from pages where id = $1`, [id]))[0]?.markdown_hash).toBeNull();
    await t.admin.query(`update pages set deleted_at = now() where id = $1`, [id]);
    expect(await pages().updateMeta(id, { title: 'No' })).toBeUndefined();
    expect((await t.admin.query<{ title: string }>(`select title from pages where id = $1`, [id]))[0]?.title).toBe('Bare2');
  });
});
