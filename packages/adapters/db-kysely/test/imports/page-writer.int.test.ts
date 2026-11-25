import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FakeOrdering } from '@tektum/grimoire-core/testing/fake-position';
import type { NewImportedPage } from '@tektum/grimoire-core/ports/import-repo';
import { createCollections } from '../../src/collections.js';
import { createPages } from '../../src/pages.js';
import { createImportRepo } from '../../src/imports.js';
import { addUser, createTestDatabase } from '../collections/support.js';
import type { TestDatabase } from '../collections/support.js';

// M7-T04, stage 4e: one page of an import in one transaction.
let t: TestDatabase;
let userId: string;
const ordering = new FakeOrdering();
const NOW = 1_700_000_000_000;
const LIMITS = { maxDepth: 32, maxPages: 10_000, maxTenantPages: 50_000 };

beforeAll(async () => {
  t = await createTestDatabase('importwriter');
  userId = await addUser(t.app, 'ada', 'admin');
}, 60_000);
afterAll(async () => { await t?.drop(); });

const collection = async (): Promise<string> => (await createCollections(t.app).append('legacy', { name: `c${randomUUID().slice(0, 8)}`, createdBy: userId }, (last) => ordering.between(last, null))).id;

/** An import into a new collection with `paths` as pending page items. */
async function started(paths: readonly string[]): Promise<{ importId: string; collectionId: string; items: Map<string, string> }> {
  const collectionId = await collection();
  // A tenant has one running import (migration 0012): the one an earlier test, or an earlier step of this one, started has ended by now, so it is ended before the next one runs.
  await t.app.query(`update imports set status = 'done', finished_at = now() where tenant_id = 'legacy' and status = 'running'`);
  const rows = await t.app.query<{ id: string }>(
    `insert into imports (tenant_id, target_collection_id, source, status, created_by) values ('legacy', $1, 'markdown_zip', 'running', $2) returning id`, [collectionId, userId],
  );
  const importId = (rows[0] as { id: string }).id;
  const repo = createImportRepo(t.app);
  await repo.addItems('legacy', importId, paths.map((path) => ({ path, kind: 'page' as const })));
  const items = new Map((await repo.pending('legacy', importId, 'page', 1000)).map((i) => [i.path, i.id]));
  return { importId, collectionId, items };
}

const page = (itemId: string, collectionId: string, over: Partial<NewImportedPage> = {}): NewImportedPage => ({
  itemId, collectionId, parentId: null, position: (before, after) => ordering.between(before, after), title: 'Imported', createdBy: userId,
  content: { state: new Uint8Array([1, 2, 3, 4]), markdown: 'Body text\n', text: 'Body text', hash: Buffer.alloc(32, 9) }, markdownBytes: 10, stateBytes: 4, attachments: [], ...over,
});

const pagesOf = (collectionId: string) => t.app.query<{ id: string; ydoc: Buffer | null; markdown: string | null; text_content: string | null; markdown_hash: Buffer | null; created_by: string; last_edited_by: string | null; parent_id: string | null; position: string; tenant_id: string }>(
  `select id, ydoc, markdown, text_content, markdown_hash, created_by, last_edited_by, parent_id, position, tenant_id from pages where collection_id = $1 and deleted_at is null order by position`, [collectionId],
);

describe('writing a page of an import', () => {
  it('writes the page with its state, one import revision, and the item as ok, together', async () => {
    const s = await started(['a.md']);
    const repo = createImportRepo(t.app);
    const out = await repo.writePage('legacy', s.importId, page(s.items.get('a.md') as string, s.collectionId), LIMITS, NOW);
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    const [row] = await pagesOf(s.collectionId);
    expect(row).toMatchObject({ id: out.pageId, markdown: 'Body text\n', text_content: 'Body text', created_by: userId, last_edited_by: userId, parent_id: null, position: expect.any(String), tenant_id: 'legacy' });
    expect(Buffer.from(row?.ydoc ?? []).equals(Buffer.from([1, 2, 3, 4]))).toBe(true);
    expect(Buffer.from(row?.markdown_hash ?? []).equals(Buffer.alloc(32, 9))).toBe(true);
    const revisions = await t.app.query<{ reason: string; markdown: string; last_author_id: string; tenant_id: string }>('select reason, markdown, last_author_id, tenant_id from revisions where page_id = $1', [out.pageId]);
    expect(revisions).toEqual([{ reason: 'import', markdown: 'Body text\n', last_author_id: userId, tenant_id: 'legacy' }]);
    expect(await repo.getItem('legacy', s.importId, s.items.get('a.md') as string)).toMatchObject({ status: 'ok', pageId: out.pageId, urlId: expect.any(String), markdownBytes: 10, stateBytes: 4, message: null });
    expect((await t.app.query<{ n: number }>(`select count(*)::int as n from pages where collection_id = $1 and deleted_at is null and text_content is null`, [s.collectionId]))[0]?.n).toBe(0);
  });

  it('a second write of the same item writes no second page (a resumed run, a duplicate delivery)', async () => {
    const s = await started(['a.md']);
    const repo = createImportRepo(t.app);
    const id = s.items.get('a.md') as string;
    expect((await repo.writePage('legacy', s.importId, page(id, s.collectionId), LIMITS, NOW)).kind).toBe('ok');
    expect(await repo.writePage('legacy', s.importId, page(id, s.collectionId), LIMITS, NOW)).toEqual({ kind: 'not-pending' });
    expect(await pagesOf(s.collectionId)).toHaveLength(1);
  });

  it('two writers of one item at once write one page', async () => {
    const s = await started(['a.md']);
    const repo = createImportRepo(t.app);
    const id = s.items.get('a.md') as string;
    const results = await Promise.all([repo.writePage('legacy', s.importId, page(id, s.collectionId), LIMITS, NOW), repo.writePage('legacy', s.importId, page(id, s.collectionId), LIMITS, NOW)]);
    expect(results.map((r) => r.kind).sort()).toEqual(['not-pending', 'ok']);
    expect(await pagesOf(s.collectionId)).toHaveLength(1);
  });

  it('a page is written under its parent, which must be live in the collection', async () => {
    const s = await started(['a.md', 'a/b.md']);
    const repo = createImportRepo(t.app);
    const parent = await repo.writePage('legacy', s.importId, page(s.items.get('a.md') as string, s.collectionId), LIMITS, NOW);
    if (parent.kind !== 'ok') throw new Error(parent.kind);
    const child = await repo.writePage('legacy', s.importId, page(s.items.get('a/b.md') as string, s.collectionId, { parentId: parent.pageId }), LIMITS, NOW);
    expect(child.kind).toBe('ok');
    expect((await pagesOf(s.collectionId)).map((r) => r.parent_id)).toEqual(expect.arrayContaining([null, parent.pageId]));
    expect(await pagesOf(s.collectionId)).toHaveLength(2);
    const other = await started(['x.md']);
    expect((await repo.writePage('legacy', other.importId, page(other.items.get('x.md') as string, other.collectionId, { parentId: parent.pageId }), LIMITS, NOW)).kind).toBe('no-parent');
  });

  it('refuses at the collection cap, at the tenant cap, and too deep, writing nothing and leaving the item pending', async () => {
    const s = await started(['a.md', 'b.md', 'c.md']);
    const repo = createImportRepo(t.app);
    const [a, b, c] = ['a.md', 'b.md', 'c.md'].map((p) => s.items.get(p) as string) as [string, string, string];
    expect((await repo.writePage('legacy', s.importId, page(a, s.collectionId), { ...LIMITS, maxPages: 2 }, NOW)).kind).toBe('ok');
    expect((await repo.writePage('legacy', s.importId, page(b, s.collectionId), { ...LIMITS, maxPages: 2 }, NOW)).kind).toBe('ok');
    expect(await repo.writePage('legacy', s.importId, page(c, s.collectionId), { ...LIMITS, maxPages: 2 }, NOW)).toEqual({ kind: 'collection-full' });
    expect(await repo.writePage('legacy', s.importId, page(c, s.collectionId), { ...LIMITS, maxTenantPages: 1 }, NOW)).toEqual({ kind: 'tenant-pages-full' });
    expect((await repo.getItem('legacy', s.importId, c))?.status).toBe('pending');
    expect(await pagesOf(s.collectionId)).toHaveLength(2);
    const parent = (await pagesOf(s.collectionId))[0]?.id as string;
    expect(await repo.writePage('legacy', s.importId, page(c, s.collectionId, { parentId: parent }), { ...LIMITS, maxDepth: 1 }, NOW)).toEqual({ kind: 'too-deep' });
  });

  it('trashed pages do not count toward the collection cap', async () => {
    const s = await started(['a.md', 'b.md']);
    const repo = createImportRepo(t.app);
    const a = await repo.writePage('legacy', s.importId, page(s.items.get('a.md') as string, s.collectionId), { ...LIMITS, maxPages: 1 }, NOW);
    if (a.kind !== 'ok') throw new Error(a.kind);
    await t.app.query('update pages set deleted_at = now() where id = $1', [a.pageId]);
    expect((await repo.writePage('legacy', s.importId, page(s.items.get('b.md') as string, s.collectionId), { ...LIMITS, maxPages: 1 }, NOW)).kind).toBe('ok');
  });

  it('writers racing for the last place of a collection fill it exactly', async () => {
    const paths = Array.from({ length: 8 }, (_, i) => `p${String(i)}.md`);
    const s = await started(paths);
    const repo = createImportRepo(t.app);
    const results = await Promise.all(paths.map((p) => repo.writePage('legacy', s.importId, page(s.items.get(p) as string, s.collectionId), { ...LIMITS, maxPages: 5 }, NOW)));
    expect(results.filter((r) => r.kind === 'ok')).toHaveLength(5);
    expect(results.filter((r) => r.kind === 'collection-full')).toHaveLength(3);
    expect(await pagesOf(s.collectionId)).toHaveLength(5);
  });

  it('a collection that was deleted, or another tenant\'s, takes no page', async () => {
    const s = await started(['a.md']);
    const repo = createImportRepo(t.app);
    const id = s.items.get('a.md') as string;
    expect((await repo.writePage('other', s.importId, page(id, s.collectionId), LIMITS, NOW)).kind).toBe('collection-deleted');
    await t.app.query('update collections set deleted_at = now() where id = $1', [s.collectionId]);
    expect(await repo.writePage('legacy', s.importId, page(id, s.collectionId), LIMITS, NOW)).toEqual({ kind: 'collection-deleted' });
    expect((await repo.getItem('legacy', s.importId, id))?.status).toBe('pending');
  });
});

describe('the ids of a page item', () => {
  it('a page is written under the page id and URL id its item was given when it was added, so a link made before holds', async () => {
    const s = await started(['a.md', 'b.md']);
    const repo = createImportRepo(t.app);
    const before = await repo.scanItems('legacy', s.importId, { limit: 10 });
    const a = before.find((i) => i.path === 'a.md');
    expect(a?.pageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(a?.urlId).toMatch(/^[0-9A-Za-z]{10}$/);
    const out = await repo.writePage('legacy', s.importId, page(s.items.get('a.md') as string, s.collectionId), LIMITS, NOW);
    expect(out).toEqual({ kind: 'ok', pageId: a?.pageId, urlId: a?.urlId });
    const rows = await t.app.query<{ id: string; url_id: string }>('select id, url_id from pages where id = $1', [a?.pageId]);
    expect(rows).toEqual([{ id: a?.pageId, url_id: a?.urlId }]);
  });

  it('an item added as skipped or failed has no ids and is not pending', async () => {
    const s = await started([]);
    const repo = createImportRepo(t.app);
    await repo.addItems('legacy', s.importId, [{ path: 'x.md', kind: 'page', status: 'failed', message: 'bad_name' }]);
    const [row] = await repo.scanItems('legacy', s.importId, { limit: 10 });
    expect(row).toMatchObject({ status: 'failed', message: 'bad_name', pageId: null, urlId: null });
  });
});

describe('the import must be running', () => {
  it.each([['cancelled'], ['done'], ['failed']])('a %s import takes no page: nothing is written and the item stays pending', async (status) => {
    const s = await started(['a.md']);
    const repo = createImportRepo(t.app);
    await t.app.query('update imports set status = $2 where id = $1', [s.importId, status]);
    const id = s.items.get('a.md') as string;
    expect(await repo.writePage('legacy', s.importId, page(id, s.collectionId), LIMITS, NOW)).toEqual({ kind: 'not-running' });
    expect(await pagesOf(s.collectionId)).toEqual([]);
    expect((await repo.getItem('legacy', s.importId, id))?.status).toBe('pending');
  });

  it('a write that meets an uncommitted cancel waits for it, then finds the import cancelled and writes nothing (the lock on the import row)', async () => {
    const s = await started(['a.md']);
    const repo = createImportRepo(t.app);
    const id = s.items.get('a.md') as string;
    let write: ReturnType<typeof repo.writePage> | undefined;
    await t.app.transaction(async (tx) => {
      await tx.query(`update imports set status = 'cancelled' where id = $1`, [s.importId]);
      write = repo.writePage('legacy', s.importId, page(id, s.collectionId), LIMITS, NOW);
      // The write is blocked on the row this transaction holds: a session of the database is waiting on a lock. Without the share lock it would read the old status, write its page and finish.
      await vi.waitFor(async () => {
        const waiting = await t.app.query<{ n: number }>(`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`);
        expect(waiting[0]?.n).toBeGreaterThan(0);
      }, { timeout: 10_000, interval: 25 });
    });
    expect(await write).toEqual({ kind: 'not-running' });
    expect(await pagesOf(s.collectionId)).toEqual([]);
    expect((await repo.getItem('legacy', s.importId, id))?.status).toBe('pending');
  });
});

describe('the position among the siblings', () => {
  it('is computed in the transaction from the last live sibling: pages made by someone else around it do not collide', async () => {
    const s = await started(['a.md', 'b.md', 'c.md', 'd.md']);
    const repo = createImportRepo(t.app);
    const pages = createPages(t.app);
    const mine = ['a.md', 'b.md', 'c.md', 'd.md'].map((p) => s.items.get(p) as string);
    const user = Array.from({ length: 4 }, () => pages.create('legacy', { collectionId: s.collectionId, parentId: null, afterId: null, title: 'mine', createdBy: userId }, LIMITS, (a, b) => ordering.between(a, b)));
    const imported = mine.map((id) => repo.writePage('legacy', s.importId, page(id, s.collectionId), LIMITS, NOW));
    const results = [...(await Promise.all(user)), ...(await Promise.all(imported))];
    expect(results.map((r) => r.kind)).toEqual(Array(8).fill('created').fill('ok', 4));
    const positions = (await pagesOf(s.collectionId)).map((r) => r.position);
    expect(new Set(positions).size).toBe(8);
  });

  it('appends after the last live sibling of the parent, and starts a new parent at the front', async () => {
    const s = await started(['a.md', 'b.md', 'a/c.md']);
    const repo = createImportRepo(t.app);
    const a = await repo.writePage('legacy', s.importId, page(s.items.get('a.md') as string, s.collectionId), LIMITS, NOW);
    const b = await repo.writePage('legacy', s.importId, page(s.items.get('b.md') as string, s.collectionId), LIMITS, NOW);
    if (a.kind !== 'ok' || b.kind !== 'ok') throw new Error('write');
    const c = await repo.writePage('legacy', s.importId, page(s.items.get('a/c.md') as string, s.collectionId, { parentId: a.pageId }), LIMITS, NOW);
    expect(c.kind).toBe('ok');
    const rows = await pagesOf(s.collectionId);
    const at = (id: string) => rows.find((r) => r.id === id)?.position as string;
    expect(at(a.pageId) < at(b.pageId)).toBe(true);
  });
});

describe('the attachments of a page', () => {
  const attachment = (over: Record<string, unknown> = {}) => ({ id: randomUUID(), uploaderId: userId, fileName: 'cat.png', contentType: 'image/png', size: 12, key: `attachments/${randomUUID()}`, readyAt: NOW, ...over });

  it('are stored ready, owned by the page, with the page and the item', async () => {
    const s = await started(['a.md']);
    const repo = createImportRepo(t.app);
    const a = attachment();
    const out = await repo.writePage('legacy', s.importId, page(s.items.get('a.md') as string, s.collectionId, { attachments: [a] }), LIMITS, NOW);
    if (out.kind !== 'ok') throw new Error(out.kind);
    const rows = await t.app.query<{ id: string; page_id: string; status: string; tenant_id: string; ready_at: Date | null }>('select id, page_id, status, tenant_id, ready_at from attachments where page_id = $1', [out.pageId]);
    expect(rows).toEqual([{ id: a.id, page_id: out.pageId, status: 'ready', tenant_id: 'legacy', ready_at: expect.any(Date) }]);
  });

  it('a failure while writing them leaves no page, no revision, no attachment row, and the item pending', async () => {
    const s = await started(['a.md']);
    const repo = createImportRepo(t.app);
    const dup = attachment();
    // The same id twice: the second insert violates the primary key, after the page and the revision were written.
    await expect(repo.writePage('legacy', s.importId, page(s.items.get('a.md') as string, s.collectionId, { attachments: [dup, dup] }), LIMITS, NOW)).rejects.toThrow();
    expect(await pagesOf(s.collectionId)).toEqual([]);
    expect((await t.app.query<{ n: number }>(`select count(*)::int as n from attachments where id = $1`, [dup.id]))[0]?.n).toBe(0);
    expect((await t.app.query<{ n: number }>(`select count(*)::int as n from revisions r join pages p on p.id = r.page_id where p.collection_id = $1`, [s.collectionId]))[0]?.n).toBe(0);
    expect((await repo.getItem('legacy', s.importId, s.items.get('a.md') as string))?.status).toBe('pending');
    // Recovery: the same item, written again with a good attachment, succeeds (no lock or status was left behind by the rollback).
    const good = attachment();
    const again = await repo.writePage('legacy', s.importId, page(s.items.get('a.md') as string, s.collectionId, { attachments: [good] }), LIMITS, NOW);
    expect(again.kind).toBe('ok');
    expect(await pagesOf(s.collectionId)).toHaveLength(1);
    expect((await t.app.query<{ n: number }>(`select count(*)::int as n from attachments where id = $1`, [good.id]))[0]?.n).toBe(1);
    expect((await repo.getItem('legacy', s.importId, s.items.get('a.md') as string))?.status).toBe('ok');
  });
});

describe('moving the pages of an import to the trash', () => {
  const deleted = (collectionId: string) =>
    t.app.query<{ id: string; deleted_batch: string | null; deleted_by: string | null; deleted_at: Date | null }>(`select id, deleted_batch, deleted_by, deleted_at from pages where collection_id = $1 order by id`, [collectionId]);

  it('moves the pages of ok items, and the pages under them that a person added, each subtree in a batch named by its root, by the importer, and a second call finds nothing', async () => {
    const s = await started(['a.md', 'a/b.md', 'z.md']);
    const repo = createImportRepo(t.app);
    const a = await repo.writePage('legacy', s.importId, page(s.items.get('a.md') as string, s.collectionId), LIMITS, NOW);
    const z = await repo.writePage('legacy', s.importId, page(s.items.get('z.md') as string, s.collectionId), LIMITS, NOW);
    if (z.kind !== 'ok') throw new Error('page z');
    if (a.kind !== 'ok') throw new Error('page a');
    const b = await repo.writePage('legacy', s.importId, page(s.items.get('a/b.md') as string, s.collectionId, { parentId: a.pageId }), LIMITS, NOW);
    if (b.kind !== 'ok') throw new Error('page b');
    await t.app.query(`update imports set status = 'cancelled', finished_at = now() where id = $1`, [s.importId]);
    // A page that is not the import's, under an imported page (a second import stands for the person who added it), and one beside it.
    const other = await t.app.query<{ id: string }>(`insert into imports (tenant_id, target_collection_id, source, status, created_by) values ('legacy', $1, 'markdown_zip', 'running', $2) returning id`, [s.collectionId, userId]);
    const otherId = (other[0] as { id: string }).id;
    await repo.addItems('legacy', otherId, [{ path: 'child.md', kind: 'page' }, { path: 'beside.md', kind: 'page' }]);
    const waiting = new Map((await repo.pending('legacy', otherId, 'page', 10)).map((i) => [i.path, i.id]));
    const child = await repo.writePage('legacy', otherId, page(waiting.get('child.md') as string, s.collectionId, { parentId: b.pageId }), LIMITS, NOW);
    const beside = await repo.writePage('legacy', otherId, page(waiting.get('beside.md') as string, s.collectionId), LIMITS, NOW);
    if (child.kind !== 'ok' || beside.kind !== 'ok') throw new Error('pages of the other import');

    const moved = await repo.trashImported('legacy', s.importId);
    expect(moved?.pages).toBe(4);
    expect([...(moved?.batches ?? [])].sort()).toEqual([a.pageId, z.pageId].sort());
    const rows = new Map((await deleted(s.collectionId)).map((r) => [r.id, r]));
    expect(rows.get(z.pageId)?.deleted_batch).toBe(z.pageId);
    for (const id of [a.pageId, b.pageId, child.pageId]) {
      expect(rows.get(id)?.deleted_batch, id).toBe(a.pageId);
      expect(rows.get(id)?.deleted_by, id).toBe(userId);
      expect(rows.get(id)?.deleted_at, id).not.toBeNull();
    }
    expect(rows.get(beside.pageId)?.deleted_at).toBeNull();
    expect(await repo.trashImported('legacy', s.importId)).toEqual({ batches: [], pages: 0 });
    expect((await deleted(s.collectionId)).filter((r) => r.deleted_batch === a.pageId)).toHaveLength(3);
  });

  it('does not touch a page of another tenant that an import names', async () => {
    const s = await started(['a.md']);
    const repo = createImportRepo(t.app);
    const a = await repo.writePage('legacy', s.importId, page(s.items.get('a.md') as string, s.collectionId), LIMITS, NOW);
    if (a.kind !== 'ok') throw new Error('page a');
    expect(await repo.trashImported('other', s.importId)).toBeUndefined();
    expect((await deleted(s.collectionId)).every((r) => r.deleted_at === null)).toBe(true);
  });
});
