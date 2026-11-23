import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { markdownHash } from '@tektum/grimoire-core/pages/hash';
import { createRevisions } from '../../src/revisions.js';
import { addUser, createTestDatabase } from '../collections/support.js';
import type { TestDatabase } from '../collections/support.js';

let t: TestDatabase;
let ana: string;
let bob: string;
let page: string;
let other: string;
const HASH = `decode(repeat('ab', 32), 'hex')`;

/** A revision written as the runtime role writes it. */
const add = async (pageId: string, ms: number, title: string, authors: string[], last: string | null, reason = 'idle'): Promise<string> =>
  ((await t.app.query<{ id: string }>(
    `insert into revisions (page_id, title, markdown, markdown_hash, author_ids, last_author_id, reason, created_at)
     values ($1, $2, $3, ${HASH}, $4::uuid[], $5, $6, timestamptz 'epoch' + $7::bigint * interval '1 millisecond') returning id`,
    [pageId, title, `text of ${title}`, authors, last, reason, ms],
  ))[0] as { id: string }).id;

beforeAll(async () => {
  t = await createTestDatabase('revs');
  ana = await addUser(t.app, 'ana', 'member');
  bob = await addUser(t.app, 'bob', 'member');
  const collection = (await t.app.query<{ id: string }>(`insert into collections (name, position, created_by) values ('C', 'a1', $1) returning id`, [ana]))[0]?.id as string;
  const mk = async (): Promise<string> => (await t.app.query<{ id: string }>(`insert into pages (collection_id, created_by) values ($1, $2) returning id`, [collection, ana]))[0]?.id as string;
  page = await mk();
  other = await mk();
}, 60_000);
afterAll(async () => { await t?.drop(); });

describe('the PostgreSQL RevisionRepo', () => {
  it('lists newest first with the authors and the last author by name, and no Markdown', async () => {
    const old = await add(page, 1_700_000_010_000, 'Old', [ana], ana);
    const recent = await add(page, 1_700_000_020_123, 'Recent', [ana, bob], bob, 'last_editor_left');
    const list = await createRevisions(t.app).list(page, { limit: 10 });
    expect(list.map((r) => r.id)).toEqual([recent, old]);
    expect(list[0]).toEqual({
      id: recent, createdAt: 1_700_000_020_123, sortKey: 1_700_000_020_123_000, title: 'Recent', reason: 'last_editor_left',
      lastAuthor: { id: bob, name: 'bob' }, authors: [{ id: ana, name: 'ana' }, { id: bob, name: 'bob' }],
    });
    expect(list[0]).not.toHaveProperty('markdown');
  });

  it('pages by keyset with no gap and no repeat, including revisions with the same time, and one page after another', async () => {
    const p = other;
    const ids: string[] = [];
    for (const [ms, title] of [[5000, 'a'], [5000, 'b'], [5000, 'c'], [4000, 'd'], [3000, 'e']] as const) ids.push(await add(p, ms, title, [], null));
    const repo = createRevisions(t.app);
    const seen: string[] = [];
    let after: readonly [number, string] | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const rows = await repo.list(p, { limit: 2, ...(after === undefined ? {} : { after }) });
      if (rows.length === 0) break;
      seen.push(...rows.map((r) => r.id));
      const last = rows.at(-1);
      after = [last?.sortKey as number, last?.id as string];
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen)).toEqual(new Set(ids));
    const times = await Promise.all(seen.map(async (id) => (await repo.get(p, id))?.createdAt as number));
    expect(times).toEqual([5000, 5000, 5000, 4000, 3000]);
  });

  it('pages through stored times finer than a millisecond, and through a later page, without a gap or a repeat', async () => {
    const p = (await t.app.query<{ id: string }>(`insert into pages (collection_id, created_by) select collection_id, created_by from pages where id = $1 returning id`, [page]))[0]?.id as string;
    const ids: string[] = [];
    for (const micros of [123_456, 123_457, 123_999, 124_000, 122_000]) {
      ids.push(((await t.app.query<{ id: string }>(
        `insert into revisions (page_id, title, markdown, markdown_hash, reason, created_at)
         values ($1, $2, 'm', ${HASH}, 'idle', timestamptz 'epoch' + $3::bigint * interval '1 microsecond') returning id`,
        [p, `t${String(micros)}`, 1_700_000_000_000_000 + micros],
      ))[0] as { id: string }).id);
    }
    const repo = createRevisions(t.app);
    const seen: string[] = [];
    let after: readonly [number, string] | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const rows = await repo.list(p, { limit: 1, ...(after === undefined ? {} : { after }) });
      if (rows.length === 0) break;
      seen.push(...rows.map((r) => r.title));
      after = [rows[0]?.sortKey as number, rows[0]?.id as string];
    }
    expect(seen).toEqual(['t124000', 't123999', 't123457', 't123456', 't122000']);
    expect(new Set(ids).size).toBe(5);
  });

  it('shows a revision with its Markdown, a last author of null once that user is gone, and nothing for another page', async () => {
    const id = await add(page, 1_700_000_030_000, 'Solo', [ana], null);
    const repo = createRevisions(t.app);
    expect(await repo.get(page, id)).toMatchObject({ id, title: 'Solo', markdown: 'text of Solo', lastAuthor: null, authors: [{ id: ana, name: 'ana' }] });
    expect(await repo.get(other, id)).toBeUndefined();
    expect(await repo.get(page, '00000000-0000-4000-8000-000000000000')).toBeUndefined();
  });

  it('is append only for the runtime role: insert and select work, update and delete fail with 42501', async () => {
    const id = await add(page, 1_700_000_040_000, 'Kept', [], null);
    await expect(t.app.query(`update revisions set title = 'changed' where id = $1`, [id])).rejects.toMatchObject({ code: '42501' });
    await expect(t.app.query(`delete from revisions where id = $1`, [id])).rejects.toMatchObject({ code: '42501' });
    expect((await t.app.query<{ title: string }>(`select title from revisions where id = $1`, [id]))[0]?.title).toBe('Kept');
  });
});

/** A page with saved Markdown, as the page store leaves it. */
const savedPage = async (over: { title?: string; markdown?: string | null; stale?: boolean; editedMs?: number | null; editedBy?: string | null } = {}): Promise<string> => {
  const title = over.title ?? 'Saved';
  const markdown = over.markdown === undefined ? 'saved text' : over.markdown;
  return ((await t.app.query<{ id: string }>(
    `insert into pages (collection_id, created_by, title, markdown, markdown_hash, markdown_stale_since, last_edited_at, last_edited_by)
     select collection_id, created_by, $1, $2::text, $3::bytea, case when $4::boolean then now() end,
            case when $5::bigint is null then null else timestamptz 'epoch' + $5::bigint * interval '1 millisecond' end, $6::uuid from pages where id = $7 returning id`,
    [title, markdown, markdown === null ? null : markdownHash(title, markdown), over.stale ?? false, over.editedMs ?? null, over.editedBy ?? null, page],
  ))[0] as { id: string }).id;
};
const revisionsOf = (pageId: string) => t.admin.query<{ reason: string; title: string; markdown: string; ms: string; author_ids: string[]; last_author_id: string | null }>(
  `select reason, title, markdown, (extract(epoch from created_at) * 1000)::bigint::text as ms, author_ids, last_author_id from revisions where page_id = $1 order by created_at, id`, [pageId]);

describe('RevisionRepo.createFromPage', () => {
  it('makes a revision of the saved state, dated at the last edit, with the authors that are users and in the order given', async () => {
    const id = await savedPage({ title: 'T1', markdown: 'body one' });
    const made = await createRevisions(t.app).createFromPage({ pageId: id, reason: 'idle', authorIds: [bob, '00000000-0000-4000-8000-0000000000ff', ana], lastAuthorId: ana, at: 1_700_000_100_123 });
    expect(made.kind).toBe('created');
    expect(await revisionsOf(id)).toEqual([{ reason: 'idle', title: 'T1', markdown: 'body one', ms: '1700000100123', author_ids: [bob, ana], last_author_id: ana }]);
    const hash = (await t.admin.query<{ markdown_hash: Buffer }>(`select markdown_hash from revisions where page_id = $1`, [id]))[0]?.markdown_hash;
    expect(hash?.equals(markdownHash('T1', 'body one'))).toBe(true);
  });

  it('skips identical title and Markdown, and makes another revision when either changes', async () => {
    const id = await savedPage({ title: 'T2', markdown: 'same' });
    const repo = createRevisions(t.app);
    const ask = (at: number) => repo.createFromPage({ pageId: id, reason: 'last_editor_left', authorIds: [ana], lastAuthorId: ana, at });
    expect((await ask(1_700_000_200_000)).kind).toBe('created');
    expect(await ask(1_700_000_201_000)).toEqual({ kind: 'unchanged' });
    await t.admin.query(`update pages set title = 'T2b', markdown_hash = $2 where id = $1`, [id, markdownHash('T2b', 'same')]);
    expect((await ask(1_700_000_202_000)).kind).toBe('created');
    expect((await revisionsOf(id)).map((r) => r.title)).toEqual(['T2', 'T2b']);
  });

  it('refuses stale Markdown, a page with no Markdown, a deleted page and an unknown page', async () => {
    const repo = createRevisions(t.app);
    const ask = (pageId: string) => repo.createFromPage({ pageId, reason: 'idle', authorIds: [], lastAuthorId: null, at: 1_700_000_300_000 });
    const stale = await savedPage({ stale: true });
    const bare = await savedPage({ markdown: null });
    const gone = await savedPage();
    await t.admin.query(`update pages set deleted_at = now() where id = $1`, [gone]);
    expect(await ask(stale)).toEqual({ kind: 'stale' });
    expect(await ask(bare)).toEqual({ kind: 'no-markdown' });
    expect(await ask(gone)).toEqual({ kind: 'no-page' });
    expect(await ask('00000000-0000-4000-8000-000000000000')).toEqual({ kind: 'no-page' });
    expect([await revisionsOf(stale), await revisionsOf(bare), await revisionsOf(gone)]).toEqual([[], [], []]);
  });

  it('drops a last author that is not a user instead of failing', async () => {
    const id = await savedPage({ title: 'T3', markdown: 'x' });
    const made = await createRevisions(t.app).createFromPage({ pageId: id, reason: 'idle', authorIds: [], lastAuthorId: '00000000-0000-4000-8000-0000000000fe', at: 1_700_000_400_000 });
    expect(made.kind).toBe('created');
    expect((await revisionsOf(id))[0]).toMatchObject({ author_ids: [], last_author_id: null });
  });
});

describe('RevisionRepo.createFromPage, concurrently and with ids that are not UUIDs', () => {
  it('makes exactly one revision when two calls for one page run at once', async () => {
    const id = await savedPage({ title: 'Race', markdown: 'raced' });
    const repo = createRevisions(t.app);
    const ask = () => repo.createFromPage({ pageId: id, reason: 'idle', authorIds: [ana], lastAuthorId: ana, at: 1_700_000_500_000 });
    const results = await Promise.all([ask(), ask(), ask(), ask()]);
    expect(results.map((r) => r.kind).sort()).toEqual(['created', 'unchanged', 'unchanged', 'unchanged']);
    expect(await revisionsOf(id)).toHaveLength(1);
  });

  it('dates the revision at a save newer than the caller\'s snapshot and names that save\'s editor as the last author', async () => {
    const id = await savedPage({ title: 'Later', markdown: 'saved after the snapshot', editedMs: 1_700_000_800_000, editedBy: bob });
    const made = await createRevisions(t.app).createFromPage({ pageId: id, reason: 'idle', authorIds: [ana], lastAuthorId: ana, at: 1_700_000_700_000 });
    expect(made.kind).toBe('created');
    expect(await revisionsOf(id)).toEqual([{ reason: 'idle', title: 'Later', markdown: 'saved after the snapshot', ms: '1700000800000', author_ids: [ana, bob], last_author_id: bob }]);
    const older = await savedPage({ title: 'Older', markdown: 'saved before', editedMs: 1_700_000_600_000, editedBy: bob });
    await createRevisions(t.app).createFromPage({ pageId: older, reason: 'idle', authorIds: [ana], lastAuthorId: ana, at: 1_700_000_700_000 });
    expect((await revisionsOf(older))[0]).toMatchObject({ ms: '1700000700000', author_ids: [ana], last_author_id: ana });
  });

  it('drops author ids that are not UUIDs before they reach the database, instead of failing', async () => {
    const id = await savedPage({ title: 'Names', markdown: 'dev tokens' });
    const made = await createRevisions(t.app).createFromPage({ pageId: id, reason: 'idle', authorIds: ['dev-user', ana, 'not-a-uuid'], lastAuthorId: 'dev-user', at: 1_700_000_600_000 });
    expect(made.kind).toBe('created');
    expect((await revisionsOf(id))[0]).toMatchObject({ author_ids: [ana], last_author_id: null });
  });
});

describe('RevisionRepo.catchUp', () => {
  const NOW = 1_700_000_900_000;
  it('dates the catch-up revision of a renamed page after the revision it follows', async () => {
    const id = await savedPage({ title: 'Old name', markdown: 'unchanged text', editedMs: NOW - 12 * 60_000, editedBy: ana });
    const repo = createRevisions(t.app);
    await repo.catchUp(NOW - 5 * 60_000, 100);
    await t.admin.query(`update pages set title = 'New name', markdown_hash = $2 where id = $1`, [id, markdownHash('New name', 'unchanged text')]);
    await repo.catchUp(NOW - 5 * 60_000, 100);
    expect((await repo.list(id, { limit: 10 })).map((r) => r.title)).toEqual(['New name', 'Old name']);
  });

  const rows = () => t.admin.query<{ id: string }>(`select id from revisions`);

  it('makes the missing revisions of pages last edited before the cut, dated at the last edit and naming the last editor, once', async () => {
    const old = await savedPage({ title: 'Old', markdown: 'old text', editedMs: NOW - 6 * 60_000, editedBy: bob });
    const recent = await savedPage({ title: 'Recent', markdown: 'recent', editedMs: NOW - 4 * 60_000, editedBy: ana });
    const stale = await savedPage({ stale: true, editedMs: NOW - 9 * 60_000, editedBy: ana });
    const bare = await savedPage({ markdown: null, editedMs: NOW - 9 * 60_000, editedBy: ana });
    const never = await savedPage({ title: 'Never edited', markdown: 'n', editedMs: null });
    const kept = await savedPage({ title: 'Kept', markdown: 'kept', editedMs: NOW - 8 * 60_000, editedBy: ana });
    await createRevisions(t.app).createFromPage({ pageId: kept, reason: 'idle', authorIds: [ana], lastAuthorId: ana, at: NOW - 8 * 60_000 });
    const repo = createRevisions(t.app);
    const made = await repo.catchUp(NOW - 5 * 60_000, 100);
    expect(made.map((m) => m.pageId)).toContain(old);
    expect(made.map((m) => m.pageId)).not.toContain(kept);
    expect(await revisionsOf(old)).toEqual([{ reason: 'idle', title: 'Old', markdown: 'old text', ms: String(NOW - 6 * 60_000), author_ids: [bob], last_author_id: bob }]);
    for (const none of [recent, stale, bare, never]) expect(await revisionsOf(none)).toEqual([]);
    expect(await revisionsOf(kept)).toHaveLength(1);
    const before = (await rows()).length;
    expect((await repo.catchUp(NOW - 5 * 60_000, 100)).filter((m) => m.pageId === old)).toEqual([]);
    expect((await rows()).length).toBe(before);
  });

  it('makes one revision, not two, when the catch-up and a revision of the same page run at once', async () => {
    const id = await savedPage({ title: 'Both', markdown: 'both ways', editedMs: NOW - 30 * 60_000, editedBy: ana });
    const repo = createRevisions(t.app);
    const [fromCatchUp, fromPage] = await Promise.all([
      repo.catchUp(NOW - 5 * 60_000, 100),
      repo.createFromPage({ pageId: id, reason: 'last_editor_left', authorIds: [ana], lastAuthorId: ana, at: NOW - 30 * 60_000 }),
    ]);
    expect((await revisionsOf(id))).toHaveLength(1);
    const caught = fromCatchUp.filter((m) => m.pageId === id).length;
    expect(caught + (fromPage.kind === 'created' ? 1 : 0)).toBe(1);
  });

  it('makes at most `limit` revisions per call, oldest edit first, and two instances at once make no duplicate', async () => {
    const pages: string[] = [];
    for (let n = 0; n < 3; n += 1) pages.push(await savedPage({ title: `Batch${String(n)}`, markdown: `batch ${String(n)}`, editedMs: NOW - 20 * 60_000 + n, editedBy: ana }));
    const repo = createRevisions(t.app);
    const first = await repo.catchUp(NOW - 5 * 60_000, 1);
    expect(first.map((m) => m.pageId)).toEqual([pages[0]]);
    const both = await Promise.all([repo.catchUp(NOW - 5 * 60_000, 100), repo.catchUp(NOW - 5 * 60_000, 100)]);
    const made = both.flat().map((m) => m.pageId).filter((p) => pages.includes(p));
    expect(made.sort()).toEqual([pages[1], pages[2]].sort());
  });
});

describe('RevisionRepo.snapshotBeforeRestore', () => {
  it('writes a before_restore revision of the last saved state, dated at the last edit and naming the last editor, once', async () => {
    const id = await savedPage({ title: 'Before', markdown: 'saved before the restore', editedMs: 1_700_001_000_000, editedBy: bob });
    const repo = createRevisions(t.app);
    const first = await repo.snapshotBeforeRestore(id);
    expect(first.kind).toBe('created');
    expect(await revisionsOf(id)).toEqual([{ reason: 'before_restore', title: 'Before', markdown: 'saved before the restore', ms: '1700001000000', author_ids: [bob], last_author_id: bob }]);
    const again = await repo.snapshotBeforeRestore(id);
    expect(again).toEqual({ kind: 'existing', id: first.kind === 'created' ? first.id : '' });
    expect(await revisionsOf(id)).toHaveLength(1);
  });

  it('makes one safety copy, not several, when restores of one page run at once, and the others name that copy', async () => {
    const id = await savedPage({ title: 'Restoring', markdown: 'at once', editedMs: 1_700_001_050_000, editedBy: ana });
    const results = await Promise.all([1, 2, 3, 4].map(() => createRevisions(t.app).snapshotBeforeRestore(id)));
    expect(results.map((r) => r.kind).sort()).toEqual(['created', 'existing', 'existing', 'existing']);
    expect(await revisionsOf(id)).toHaveLength(1);
  });

  it('sorts the safety copy of a renamed page as the newest revision, so the next restore finds it and writes no second copy', async () => {
    const id = await savedPage({ title: 'Before rename', markdown: 'same text', editedMs: 1_700_001_300_000, editedBy: ana });
    const repo = createRevisions(t.app);
    const first = await repo.snapshotBeforeRestore(id);
    // A rename changes the title and the hash, not the time of the last edit.
    await t.admin.query(`update pages set title = 'After rename', markdown_hash = $2 where id = $1`, [id, markdownHash('After rename', 'same text')]);
    const second = await repo.snapshotBeforeRestore(id);
    expect([first.kind, second.kind]).toEqual(['created', 'created']);
    const listed = await repo.list(id, { limit: 10 });
    expect(listed.map((r) => r.title)).toEqual(['After rename', 'Before rename']);
    expect(listed[0]?.createdAt).toBeGreaterThan(listed[1]?.createdAt ?? 0);
    expect(await repo.snapshotBeforeRestore(id)).toEqual({ kind: 'existing', id: second.kind === 'created' ? second.id : '' });
    expect(await revisionsOf(id)).toHaveLength(2);
  });

  it('writes another when the title or Markdown changed since the latest revision', async () => {
    const id = await savedPage({ title: 'Same', markdown: 'one', editedMs: 1_700_001_100_000, editedBy: ana });
    const repo = createRevisions(t.app);
    await repo.snapshotBeforeRestore(id);
    await t.admin.query(`update pages set markdown = 'two', markdown_hash = $2 where id = $1`, [id, markdownHash('Same', 'two')]);
    expect((await repo.snapshotBeforeRestore(id)).kind).toBe('created');
    expect((await revisionsOf(id)).map((r) => r.markdown)).toEqual(['one', 'two']);
  });

  it('refuses stale Markdown, says nothing is saved for a page without Markdown, and finds no deleted or unknown page, writing nothing', async () => {
    const repo = createRevisions(t.app);
    const stale = await savedPage({ stale: true });
    const bare = await savedPage({ markdown: null });
    const gone = await savedPage();
    await t.admin.query(`update pages set deleted_at = now() where id = $1`, [gone]);
    expect(await repo.snapshotBeforeRestore(stale)).toEqual({ kind: 'stale' });
    expect(await repo.snapshotBeforeRestore(bare)).toEqual({ kind: 'nothing-saved' });
    expect(await repo.snapshotBeforeRestore(gone)).toEqual({ kind: 'no-page' });
    expect(await repo.snapshotBeforeRestore('00000000-0000-4000-8000-000000000000')).toEqual({ kind: 'no-page' });
    expect([await revisionsOf(stale), await revisionsOf(bare), await revisionsOf(gone)]).toEqual([[], [], []]);
  });

  it('names no author for a page whose last editor is unknown', async () => {
    const id = await savedPage({ title: 'Anon', markdown: 'text', editedMs: 1_700_001_200_000, editedBy: null });
    await createRevisions(t.app).snapshotBeforeRestore(id);
    expect((await revisionsOf(id))[0]).toMatchObject({ author_ids: [], last_author_id: null });
  });
});
