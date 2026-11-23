import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
     values ($1, $2, $3, ${HASH}, $4::uuid[], $5, $6, to_timestamp($7::double precision / 1000.0)) returning id`,
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
      id: recent, createdAt: 1_700_000_020_123, title: 'Recent', reason: 'last_editor_left',
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
      after = [last?.createdAt as number, last?.id as string];
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen)).toEqual(new Set(ids));
    const times = await Promise.all(seen.map(async (id) => (await repo.get(p, id))?.createdAt as number));
    expect(times).toEqual([5000, 5000, 5000, 4000, 3000]);
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
