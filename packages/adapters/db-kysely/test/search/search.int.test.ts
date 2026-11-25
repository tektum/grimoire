import { randomUUID } from 'node:crypto';
import { InvalidSearchCursor } from '@tektum/grimoire-core/search/cursor';
import { SearchTimeoutError, type SearchHit, type SearchRepo } from '@tektum/grimoire-core/ports/search-repo';
import { insertCollection, insertPage, insertUser, raw } from '@tektum/grimoire-test-support/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSearchRepo } from '../../src/search.js';
import { createTestDatabase } from '../collections/support.js';
import type { TestDatabase } from '../collections/support.js';

let t: TestDatabase;
let repo: SearchRepo;
const run = (sql: string): Promise<unknown> => t.admin.query(sql);
const TENANT = 'legacy';
let user: string;
let open: string; // a collection the person may read
let hidden: string; // one they may not
const sees = () => [open];

beforeAll(async () => {
  t = await createTestDatabase('search');
  repo = createSearchRepo(t.app, { statementTimeoutMs: 5000 });
  user = await insertUser(run);
  open = await insertCollection(run, { created_by: user });
  hidden = await insertCollection(run, { created_by: user });
}, 120_000);
afterAll(async () => { await t?.drop(); });

interface PageOptions { readonly collection?: string; readonly tenant?: string; readonly body?: string; readonly deleted?: boolean; readonly editedMinutesAgo?: number }
async function page(title: string, o: PageOptions = {}): Promise<string> {
  return insertPage(run, {
    collection_id: o.collection ?? open, created_by: user, tenant_id: o.tenant ?? TENANT, title, text_content: o.body ?? '',
    last_edited_at: raw(`now() - interval '${String(o.editedMinutesAgo ?? 1)} minutes'`),
    ...(o.deleted === true ? { deleted_at: raw('now()'), deleted_batch: randomUUID() } : {}),
  });
}
const find = (query: string, over: Partial<Parameters<SearchRepo['search']>[0]> = {}) => repo.search({ tenantId: TENANT, collectionIds: sees(), query, limit: 50, ...over });
const ids = (hits: readonly SearchHit[]) => hits.map((h) => h.pageId);

describe('search: what is found', () => {
  it('finds a page by its body and ranks a title match above a body-only match', async () => {
    const body = await page('Notes', { body: 'the zebrafish migration plan' });
    const title = await page('Zebrafish handbook', { body: 'unrelated' });
    const { hits } = await find('zebrafish');
    expect(ids(hits)).toEqual([title, body]);
    expect(hits[0]).toMatchObject({ title: 'Zebrafish handbook', collectionId: open, partial: false });
    expect(hits[1]?.snippet).toEqual({ text: 'zebrafish migration plan', ranges: [[0, 9]] }); // the headline starts at the match
    expect(typeof hits[0]?.updatedAt).toBe('number');
  });

  it('gives a page that matched by its title only the start of its text and no ranges', async () => {
    await page('Quokka onboarding', { body: 'Welcome to the team. '.repeat(20) });
    const { hits } = await find('quokka');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.snippet.ranges).toEqual([]);
    expect(hits[0]?.snippet.text).toBe('Welcome to the team. '.repeat(20).slice(0, 160));
  });

  it('never makes a match out of a page that holds the control characters the snippet uses', async () => {
    await page('Control', { body: 'a\u0001b\u0002c needle d\u0001e needle' });
    const { hits } = await find('needle');
    const snippet = hits.find((h) => h.title === 'Control')?.snippet;
    expect(snippet?.text).toBe('needle d e needle'); // the characters became spaces before the headline was cut, so none of them is a marker
    expect(snippet?.ranges).toEqual([[0, 6], [11, 17]]);
  });

  it('answers a query of symbols with an empty list', async () => {
    expect((await find('!!! ??? ---')).hits).toEqual([]);
    expect((await find('%%%')).hits).toEqual([]);
  });

  it('leaves out trashed pages', async () => {
    await page('Gone narwhal', { deleted: true });
    expect((await find('narwhal')).hits).toEqual([]);
  });
});

describe('search: who may see what', () => {
  it('returns nothing for a term that exists only in a collection the person cannot read, by body or by title', async () => {
    await page('Secret platypus', { collection: hidden, body: 'platypus platypus' });
    expect((await find('platypus')).hits).toEqual([]);
    expect((await find('platypu')).hits).toEqual([]); // the title branch obeys the same predicate
  });

  it('pages through three visible matches among three invisible ones, with no count and no invisible id', async () => {
    const visible = [await page('Marmot one', { editedMinutesAgo: 3 }), await page('Marmot two', { editedMinutesAgo: 2 }), await page('Marmot three', { editedMinutesAgo: 1 })];
    const invisible = [await page('Marmot four', { collection: hidden }), await page('Marmot five', { collection: hidden }), await page('Marmot six', { collection: hidden })];
    const first = await find('marmot', { limit: 2 });
    expect(first.hits).toHaveLength(2);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await find('marmot', { limit: 2, ...(first.nextCursor === undefined ? {} : { cursor: first.nextCursor }) });
    expect(second.hits).toHaveLength(1);
    expect(second.nextCursor).toBeUndefined();
    const all = [...first.hits, ...second.hits];
    expect(new Set(ids(all))).toEqual(new Set(visible));
    expect(JSON.stringify([first, second])).not.toMatch(/total|count/i);
    for (const id of invisible) expect(JSON.stringify([first, second])).not.toContain(id);
  });

  it('answers a collection the person cannot read with an empty list, and filters by one they can', async () => {
    await page('Wombat plan', { collection: hidden });
    await page('Wombat plan open');
    expect((await find('wombat', { collectionId: hidden })).hits).toEqual([]);
    expect((await find('wombat', { collectionId: open })).hits.map((h) => h.title)).toEqual(['Wombat plan open']);
    expect((await find('wombat', { collectionId: randomUUID() })).hits).toEqual([]);
  });

  it('never crosses tenants, whatever collections it is given', async () => {
    await run(`insert into tenants (id, name) values ('T-other', 'Other') on conflict do nothing`);
    const otherUser = await insertUser(run, { tenant_id: 'T-other' });
    const otherCollection = await insertCollection(run, { created_by: otherUser, tenant_id: 'T-other' });
    await page('Ocelot atlas', { collection: otherCollection, tenant: 'T-other' });
    await page('Ocelot guide');
    expect((await find('ocelot')).hits.map((h) => h.title)).toEqual(['Ocelot guide']);
    expect((await find('ocelot', { collectionIds: [open, otherCollection] })).hits.map((h) => h.title)).toEqual(['Ocelot guide']);
    expect((await find('ocelot', { tenantId: 'T-other', collectionIds: [otherCollection] })).hits.map((h) => h.title)).toEqual(['Ocelot atlas']);
    expect((await find('ocelot', { tenantId: 'T-other' })).hits).toEqual([]);
  });
});

describe('search: no page fails on size', () => {
  const words = (n: number): string => Array.from({ length: n }, (_, i) => `w${i.toString(36)}x`).join(' ');

  it('indexes a 1 MB page of distinct words by a prefix, finds it by its title and an early word, and says it is partial', async () => {
    const body = `${words(200_000)} needlelast`;
    expect(body.length).toBeGreaterThan(1_000_000);
    const id = await page('Immense distinct', { body });
    await run(`update pages set text_content = text_content || ' more' where id = '${id}'`); // an update does not fail either
    const early = await find('w5x');
    expect(early.hits.find((h) => h.pageId === id)?.partial).toBe(true);
    expect(ids((await find('immense')).hits)).toContain(id);
    expect(ids((await find('needlelast')).hits)).not.toContain(id); // beyond the indexed prefix
  }, 120_000);

  it('indexes a 1 MB page of a few repeated words in full, and finds a word at its very end', async () => {
    const id = await page('Immense repeated', { body: `${'alpha beta gamma '.repeat(65_000)}terminalword` });
    const { hits } = await find('terminalword');
    expect(hits.find((h) => h.pageId === id)).toMatchObject({ partial: false });
  }, 120_000);
});

describe('search: titles that are not typed exactly', () => {
  it('finds Quarterly planning by a typo and by a substring, and a full-text hit ranks above a typo hit', async () => {
    const typo = await page('Quarterly planning');
    const exact = await page('Notes', { body: 'quartrly plannng numbers' });
    expect(ids((await find('quartrly plannng')).hits)).toEqual([exact, typo]);
    expect(ids((await find('plann')).hits)).toContain(typo);
  });

  it('finds a Chinese title by a two-character substring, and a two-character query matches no title by similarity', async () => {
    const zh = await page('季度规划会议');
    expect(ids((await find('规划')).hits)).toEqual([zh]);
    expect(await find('qu')).toMatchObject({ hits: expect.not.arrayContaining([expect.objectContaining({ title: 'Quarterly planning' })]) });
  });

  it('treats the characters of the query as themselves in a substring match', async () => {
    const id = await page('100% done_ok');
    expect(ids((await find('100%')).hits)).toEqual([id]);
    expect(ids((await find('done_ok')).hits)).toEqual([id]);
    expect(await find('0_d')).toMatchObject({ hits: [] });
  });
});

describe('search: order and keyset', () => {
  it('returns 120 matches in three pages of 50, every row once, in rank, edit time and id order', async () => {
    await run(`
      insert into pages (collection_id, created_by, tenant_id, title, text_content, last_edited_at)
      select '${open}', '${user}', '${TENANT}', 'Keyset ' || g, 'keysetword ' || repeat('filler ', g % 5), now() - (g % 7) * interval '1 minute' from generate_series(1, 120) g`);
    const seen: SearchHit[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 3; i += 1) {
      const page1 = await find('keysetword', { limit: 50, ...(cursor === undefined ? {} : { cursor }) });
      seen.push(...page1.hits);
      cursor = page1.nextCursor;
      expect(page1.nextCursor === undefined).toBe(i === 2);
    }
    expect(seen).toHaveLength(120);
    expect(new Set(ids(seen)).size).toBe(120);
    const sorted = [...seen].sort((a, b) => b.rank - a.rank || b.updatedAt - a.updatedAt || (a.pageId < b.pageId ? 1 : -1));
    expect(ids(seen)).toEqual(ids(sorted));
  }, 60_000);
});

describe('search: bad input and the time limit', () => {
  it('refuses a cursor this repository did not issue', async () => {
    for (const cursor of ['nonsense', 'e30', Buffer.from('{"k":[1,2,"x"]}').toString('base64url')]) await expect(find('marmot', { cursor })).rejects.toBeInstanceOf(InvalidSearchCursor);
  });

  it('gives up with SearchTimeoutError when the statement runs past its limit', async () => {
    await run(`insert into pages (collection_id, created_by, tenant_id, title, text_content) select '${open}', '${user}', '${TENANT}', 'Bulk ' || g, repeat('timeoutword filler ', 200) from generate_series(1, 5000) g`);
    const tight = createSearchRepo(t.app, { statementTimeoutMs: 1 });
    await expect(tight.search({ tenantId: TENANT, collectionIds: sees(), query: 'timeoutword filler', limit: 50 })).rejects.toBeInstanceOf(SearchTimeoutError);
    expect((await find('timeoutword', { limit: 2 })).hits).toHaveLength(2); // the same query with the normal limit works, and the connection is clean
  }, 120_000);
});
