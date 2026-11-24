import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { markdownHash } from '@tektum/grimoire-core/pages/hash';
import { isSeedRefusal, seedUserMarkdown } from '@tektum/grimoire-core/pages/seeded-content';
import type { PageLimits } from '@tektum/grimoire-core/ports/page-repo';
import { FakeMarkdownConverter } from '@tektum/grimoire-core/testing/fake-markdown-converter';
import { FakeOrdering } from '@tektum/grimoire-core/testing/fake-position';
import { createCollections } from '../../src/collections.js';
import { createPages } from '../../src/pages.js';
import { addUser, createTestDatabase } from '../collections/support.js';
import type { TestDatabase } from '../collections/support.js';

let t: TestDatabase;
let user: string;
const ordering = new FakeOrdering();
const between = (before: string | null, after: string | null): string => ordering.between(before, after);
const limits: PageLimits = { maxDepth: 32, maxPages: 10_000 };
const collectionsRepo = () => createCollections(t.app);
const newCollection = async (name: string): Promise<string> => (await collectionsRepo().append({ name, createdBy: user }, (last) => ordering.between(last, null))).id;
const create = (collectionId: string, extra: { parentId?: string; afterId?: string; beforeId?: string; title?: string } = {}, l: PageLimits = limits) =>
  createPages(t.app).create({ collectionId, parentId: extra.parentId ?? null, afterId: extra.afterId ?? null, beforeId: extra.beforeId ?? null, title: extra.title ?? 'T', createdBy: user }, l, between);
const created = async (r: ReturnType<typeof create>) => {
  const result = await r;
  if (result.kind !== 'created') throw new Error(result.kind);
  return result.page;
};

beforeAll(async () => {
  t = await createTestDatabase('pages');
  user = await addUser(t.app, 'ada', 'admin');
}, 60_000);
afterAll(async () => { await t?.drop(); });

describe('the PostgreSQL PageRepo create', () => {
  it('puts a page last, after a sibling, or between two, among siblings of one parent only', async () => {
    const c = await newCollection('order');
    const a = await created(create(c));
    const z = await created(create(c));
    const mid = await created(create(c, { afterId: a.id }));
    const child = await created(create(c, { parentId: a.id }));
    expect(a.position < mid.position && mid.position < z.position).toBe(true);
    expect([a.parentId, child.parentId, a.collectionId, a.createdBy]).toEqual([null, a.id, c, user]);
    expect(a.urlId).toMatch(/\S+/);
    const sibling = await create(c, { parentId: a.id, afterId: z.id });
    expect(sibling).toEqual({ kind: 'no-after' });
  });

  it('puts a page before a sibling, first or between two, and refuses a sibling of another parent or collection, deleted or unknown', async () => {
    const c = await newCollection('before');
    const a = await created(create(c));
    const z = await created(create(c));
    const first = await created(create(c, { beforeId: a.id }));
    const mid = await created(create(c, { beforeId: z.id }));
    expect(first.position < a.position && a.position < mid.position && mid.position < z.position).toBe(true);
    const child = await created(create(c, { parentId: a.id }));
    expect(await create(c, { beforeId: child.id })).toEqual({ kind: 'no-after' }); // a sibling of another parent
    expect(await create(c, { parentId: a.id, beforeId: z.id })).toEqual({ kind: 'no-after' });
    const other = await newCollection('before-other');
    expect(await create(other, { beforeId: a.id })).toEqual({ kind: 'no-after' }); // a page of another collection
    await t.admin.query(`update pages set deleted_at = now() where id = $1`, [z.id]);
    expect(await create(c, { beforeId: z.id })).toEqual({ kind: 'no-after' });
    expect(await create(c, { beforeId: '00000000-0000-4000-8000-000000000999' })).toEqual({ kind: 'no-after' });
  });

  it('stores the Markdown, the search text, the state and the hash in one insert, and nothing for a page without Markdown', async () => {
    const c = await newCollection('content');
    const converter = new FakeMarkdownConverter({ seed: { ok: true, state: new Uint8Array([9, 8, 7, 6]) }, convert: { ok: true, markdown: '# Hi', text: 'Hi' } });
    const seeded = await seedUserMarkdown(converter, user, 'Title', '# raw');
    if (isSeedRefusal(seeded)) throw new Error('refused');
    const r = await createPages(t.app).create({ collectionId: c, parentId: null, afterId: null, title: 'Title', createdBy: user, content: seeded }, limits, between);
    if (r.kind !== 'created') throw new Error(r.kind);
    const row = (await t.admin.query<{ markdown: string; text_content: string; ydoc: Buffer; ydoc_size: number; markdown_hash: Buffer; state_epoch: number }>(
      `select markdown, text_content, ydoc, ydoc_size, markdown_hash, state_epoch from pages where id = $1`, [r.page.id]))[0];
    expect(row?.markdown).toBe('# Hi');
    expect(row?.text_content).toBe('Hi');
    expect([...(row?.ydoc ?? [])]).toEqual([9, 8, 7, 6]);
    expect([row?.ydoc_size, row?.state_epoch]).toEqual([4, 0]);
    expect(row?.markdown_hash.equals(markdownHash('Title', '# Hi'))).toBe(true);
    const bare = await created(create(c));
    const empty = (await t.admin.query<{ markdown: string | null; ydoc: Buffer | null; markdown_hash: Buffer | null }>(`select markdown, ydoc, markdown_hash from pages where id = $1`, [bare.id]))[0];
    expect(empty).toEqual({ markdown: null, ydoc: null, markdown_hash: null });
    expect(Number((await t.admin.query<{ n: string }>(`select count(*) as n from pages where markdown is not null and ydoc is null`))[0]?.n)).toBe(0);
  });

  it('refuses Markdown with an empty editor state in the statement itself, and inserts nothing', async () => {
    const c = await newCollection('empty-state');
    const converter = new FakeMarkdownConverter({ seed: { ok: true, state: new Uint8Array(0) }, convert: { ok: true, markdown: 'x', text: 'x' } });
    const seeded = await seedUserMarkdown(converter, user, 'T', 'x');
    if (isSeedRefusal(seeded)) throw new Error('refused');
    await expect(createPages(t.app).create({ collectionId: c, parentId: null, afterId: null, title: 'T', createdBy: user, content: seeded }, limits, between)).rejects.toThrow(/cannot be empty/);
    expect(Number((await t.admin.query<{ n: string }>(`select count(*) as n from pages where collection_id = $1`, [c]))[0]?.n)).toBe(0);
  });

  it('refuses a missing parent, a parent in another collection or deleted, and the level after the deepest', async () => {
    const c = await newCollection('tree');
    const other = await newCollection('elsewhere');
    const elsewhere = await created(create(other));
    expect(await create(c, { parentId: elsewhere.id })).toEqual({ kind: 'no-parent' });
    expect(await create(c, { parentId: '00000000-0000-4000-8000-000000000000' })).toEqual({ kind: 'no-parent' });
    let parent: string | undefined;
    for (let level = 1; level <= 3; level += 1) parent = (await created(create(c, parent === undefined ? {} : { parentId: parent }, { maxDepth: 3, maxPages: 100 }))).id;
    expect(await create(c, { parentId: parent as string }, { maxDepth: 3, maxPages: 100 })).toEqual({ kind: 'too-deep' });
    await t.admin.query(`update pages set deleted_at = now() where id = $1`, [parent]);
    expect(await create(c, { parentId: parent as string })).toEqual({ kind: 'no-parent' });
  });

  it('refuses the 10,001st live page of a collection, and a deleted page does not count', async () => {
    const c = await newCollection('full');
    await t.admin.query(
      `insert into pages (collection_id, created_by, position) select $1, $2, 'b' || lpad(g::text, 6, '0') from generate_series(1, 10000) g`, [c, user],
    );
    expect(await create(c)).toEqual({ kind: 'collection-full' });
    await t.admin.query(`update pages set deleted_at = now() where id = (select id from pages where collection_id = $1 limit 1)`, [c]);
    expect((await create(c)).kind).toBe('created');
  });

  it('refuses a collection deleted while the create waited for its lock, and inserts nothing', async () => {
    const c = await newCollection('race');
    let release!: () => void;
    let held!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const locked = new Promise<void>((resolve) => { held = resolve; });
    // Another transaction holds the collection and deletes it; the create is started meanwhile and queues behind it.
    const deleter = t.app.transaction(async (tx) => {
      await tx.query(`select 1 from collections where id = $1 for update`, [c]);
      held();
      await gate;
      await tx.query(`update collections set deleted_at = now() where id = $1`, [c]);
    });
    await locked;
    const pending = create(c);
    await vi.waitFor(async () => {
      const waiting = await t.app.query<{ n: string }>(`select count(*) as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`);
      expect(Number(waiting[0]?.n)).toBe(1);
    });
    release();
    await deleter;
    expect(await pending).toEqual({ kind: 'collection-deleted' });
    expect(Number((await t.admin.query<{ n: string }>(`select count(*) as n from pages where collection_id = $1`, [c]))[0]?.n)).toBe(0);
    expect(await create('00000000-0000-4000-8000-000000000000')).toEqual({ kind: 'collection-deleted' });
  });
});
