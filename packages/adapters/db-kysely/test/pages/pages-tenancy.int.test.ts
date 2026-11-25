import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { purgeBatch } from '@tektum/grimoire-core/pages/purge';
import { isSeedRefusal, seedUserMarkdown } from '@tektum/grimoire-core/pages/seeded-content';
import type { TenantPageLimits, PageMeta } from '@tektum/grimoire-core/ports/page-repo';
import { FakeMarkdownConverter } from '@tektum/grimoire-core/testing/fake-markdown-converter';
import { FakeOrdering } from '@tektum/grimoire-core/testing/fake-position';
import { createCollections } from '../../src/collections.js';
import { createPageState } from '../../src/page-state.js';
import { createPages } from '../../src/pages.js';
import { createRevisions } from '../../src/revisions.js';
import { createTrash } from '../../src/trash.js';
import { addTenant, addUser, createTestDatabase } from '../collections/support.js';
import type { TestDatabase } from '../collections/support.js';

// docs/tenancy.md section 7, surfaces 1 and 5 (pages, history and trash): a page, its trash entry and its revisions belong to the tenant of its collection; another tenant sees
// them as absent, and the rows written for a tenant other than legacy carry it.
const ordering = new FakeOrdering();
const limits: TenantPageLimits = { maxDepth: 32, maxPages: 10_000, maxTenantPages: 50_000 };
const place = (before: string | null, after: string | null) => ordering.between(before, after);
let t: TestDatabase;
let a: { boss: string; collection: string };
let b: { boss: string; collection: string };
const pages = () => createPages(t.app);

async function make(tenant: string, collectionId: string, createdBy: string, title: string, markdown?: string): Promise<PageMeta> {
  let content;
  if (markdown !== undefined) {
    const seeded = await seedUserMarkdown(new FakeMarkdownConverter({ seed: { ok: true, state: new Uint8Array([1, 2]) }, convert: { ok: true, markdown, text: markdown } }), createdBy, title, markdown);
    if (isSeedRefusal(seeded)) throw new Error('refused');
    content = seeded;
  }
  const r = await pages().create(tenant, { collectionId, parentId: null, afterId: null, title, createdBy, content }, limits, place);
  if (r.kind !== 'created') throw new Error(r.kind);
  return r.page;
}
const tenantOf = async (table: 'pages' | 'revisions', id: string) => (await t.admin.query<{ tenant_id: string }>(`select tenant_id from ${table} where id = $1`, [id]))[0]?.tenant_id;

beforeAll(async () => {
  t = await createTestDatabase('pagetenancy');
  await addTenant(t.app, 'T-a');
  await addTenant(t.app, 'T-b');
  const collections = createCollections(t.app);
  const after = (last: string | null): string => ordering.between(last, null);
  const bossA = await addUser(t.app, 'boss-a', 'admin', 'T-a');
  const bossB = await addUser(t.app, 'boss-b', 'admin', 'T-b');
  a = { boss: bossA, collection: (await collections.append('T-a', { name: 'Docs', createdBy: bossA }, after)).id };
  b = { boss: bossB, collection: (await collections.append('T-b', { name: 'Docs', createdBy: bossB }, after)).id };
}, 60_000);
afterAll(async () => { await t?.drop(); });

describe('the PostgreSQL PageRepo across tenants', () => {
  it('creates a page in a collection of a tenant other than legacy, under that tenant', async () => {
    const page = await make('T-b', b.collection, b.boss, 'Mine');
    expect(await tenantOf('pages', page.id)).toBe('T-b');
    expect((await pages().get('T-b', page.id))?.title).toBe('Mine');
  });

  it('refuses a page in the collection of another tenant as a collection that is not there, and writes nothing', async () => {
    const before = await t.admin.query(`select 1 from pages where collection_id = $1`, [a.collection]);
    const r = await pages().create('T-b', { collectionId: a.collection, parentId: null, afterId: null, title: 'Intruder', createdBy: b.boss }, limits, place);
    expect(r).toEqual({ kind: 'collection-deleted' });
    expect(await t.admin.query(`select 1 from pages where collection_id = $1`, [a.collection])).toHaveLength(before.length);
  });

  it('answers for a page of another tenant as for a page that is not there, and changes nothing of it', async () => {
    const page = await make('T-a', a.collection, a.boss, 'Secret', '# Secret');
    expect(await pages().get('T-b', page.id)).toBeUndefined();
    expect(await pages().markdownOf('T-b', page.id)).toBeUndefined();
    expect(await pages().idOfUrlId('T-b', page.urlId)).toBeUndefined();
    expect(await pages().updateMeta('T-b', page.id, { title: 'Renamed' })).toBeUndefined();
    const to = { expectedCollectionId: a.collection, collectionId: null, parentId: null, afterId: null };
    expect(await pages().move('T-b', page.id, to, limits, place)).toEqual({ kind: 'not-found' });
    expect(await pages().softDelete('T-b', page.id, b.boss, a.collection)).toEqual({ kind: 'not-found' });
    expect(await pages().idOfUrlId('T-a', page.urlId)).toBe(page.id);
    expect((await pages().markdownOf('T-a', page.id))?.markdown).toBe('# Secret');
    expect(await pages().get('T-a', page.id)).toMatchObject({ title: 'Secret', collectionId: a.collection });
  });

  it('refuses a move into the collection of another tenant as a collection that is not there; the page stays in its tenant', async () => {
    const page = await make('T-a', a.collection, a.boss, 'Stays');
    const r = await pages().move('T-a', page.id, { expectedCollectionId: a.collection, collectionId: b.collection, parentId: null, afterId: null }, limits, place);
    expect(r).toEqual({ kind: 'collection-deleted' });
    expect(await pages().get('T-a', page.id)).toMatchObject({ collectionId: a.collection });
    expect(await tenantOf('pages', page.id)).toBe('T-a');
  });
});

describe('the PostgreSQL TrashRepo across tenants', () => {
  it('lists, finds and restores only the deleted pages of the tenant asked for', async () => {
    const trash = createTrash(t.app);
    const mine = await make('T-b', b.collection, b.boss, 'Binned b');
    const theirs = await make('T-a', a.collection, a.boss, 'Binned a');
    await pages().softDelete('T-b', mine.id, b.boss, b.collection);
    await pages().softDelete('T-a', theirs.id, a.boss, a.collection);
    expect((await trash.roots('T-b', null, 50)).map((r) => r.id)).toEqual([mine.id]);
    expect((await trash.roots('T-b', [a.collection], 50))).toEqual([]);
    expect(await trash.rootOf('T-b', theirs.id)).toBeUndefined();
    expect(await trash.restore('T-b', theirs.id, a.collection, limits, place)).toEqual({ kind: 'not-found' });
    expect((await trash.rootOf('T-a', theirs.id))?.batch).toBe(theirs.id);
    expect(await trash.restore('T-b', mine.id, b.collection, limits, place)).toMatchObject({ kind: 'restored' });
  });

  it('purges only a batch of the tenant asked for, and writes the audit row under it', async () => {
    const trash = createTrash(t.app);
    const page = await make('T-b', b.collection, b.boss, 'Purged');
    await pages().softDelete('T-b', page.id, b.boss, b.collection);
    expect(await trash.purge('T-a', page.id, a.boss, [])).toEqual({ pages: 0 });
    expect(await tenantOf('pages', page.id)).toBe('T-b');
    expect(await purgeBatch({ trash, deleteFiles: () => Promise.resolve() }, 'T-b', page.id, b.boss)).toEqual({ pages: 1, files: 0 });
    const audit = await t.app.query<{ tenant_id: string }>(`select tenant_id from audit_events where action = 'page.purged' and target_id = $1`, [page.id]);
    expect(audit).toEqual([{ tenant_id: 'T-b' }]);
  });
});

describe('the PostgreSQL RevisionRepo across tenants', () => {
  it('writes every revision of a page under the page\'s tenant, and shows it to that tenant only', async () => {
    const revisions = createRevisions(t.app, t.ops);
    const made = await make('T-b', b.collection, b.boss, 'History', '# One');
    expect(await revisions.createFromPage({ tenantId: 'T-a', pageId: made.id, reason: 'idle', authorIds: [a.boss], lastAuthorId: a.boss, at: Date.now() })).toEqual({ kind: 'no-page' });
    const created = await revisions.createFromPage({ tenantId: 'T-b', pageId: made.id, reason: 'idle', authorIds: [b.boss], lastAuthorId: b.boss, at: Date.now() });
    if (created.kind !== 'created') throw new Error(created.kind);
    expect(await tenantOf('revisions', created.id)).toBe('T-b');
    expect(await revisions.list('T-a', made.id, { limit: 10 })).toEqual([]);
    expect(await revisions.get('T-a', made.id, created.id)).toBeUndefined();
    expect((await revisions.list('T-b', made.id, { limit: 10 })).map((r) => r.id)).toEqual([created.id]);
    expect((await revisions.get('T-b', made.id, created.id))?.markdown).toBe('# One');

    const restored = await make('T-b', b.collection, b.boss, 'Safety', '# Two');
    // Scoped to the caller's tenant: another tenant's page id is no page, and nothing is written for it.
    expect(await revisions.snapshotBeforeRestore('T-a', restored.id)).toEqual({ kind: 'no-page' });
    const copy = await revisions.snapshotBeforeRestore('T-b', restored.id);
    if (copy.kind !== 'created') throw new Error(copy.kind);
    expect(await tenantOf('revisions', copy.id)).toBe('T-b');

    const idle = await make('T-b', b.collection, b.boss, 'Idle', '# Three');
    await t.admin.query(`update pages set last_edited_at = now() - interval '1 hour', last_edited_by = $2 where id = $1`, [idle.id, b.boss]);
    const caught = await revisions.catchUp(Date.now(), 10);
    const mine = caught.find((r) => r.pageId === idle.id);
    expect(mine).toBeDefined();
    expect(await tenantOf('revisions', mine?.revisionId as string)).toBe('T-b');
  });
});

describe('the PostgreSQL PageStateRepo across tenants', () => {
  it('writes the audit row of a reset under the page\'s tenant, and another tenant cannot reset it', async () => {
    const page = await make('T-b', b.collection, b.boss, 'Reset');
    expect(await createPageState(t.app).reset({ tenantId: 'T-a', pageId: page.id, actorId: a.boss, confirmStale: true })).toEqual({ kind: 'not-found' });
    expect(await createPageState(t.app).reset({ tenantId: 'T-b', pageId: page.id, actorId: b.boss, confirmStale: true })).toMatchObject({ kind: 'reset' });
    const audit = await t.app.query<{ tenant_id: string }>(`select tenant_id from audit_events where action = 'page.state_reset' and target_id = $1`, [page.id]);
    expect(audit).toEqual([{ tenant_id: 'T-b' }]);
  });
});
