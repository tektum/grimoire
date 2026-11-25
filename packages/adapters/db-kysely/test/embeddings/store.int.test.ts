import { randomUUID } from 'node:crypto';
import type { ChunkRow, EmbeddingStore } from '@tektum/grimoire-core/ports/embedding-store';
import { adminUrl, insertCollection, insertPage, insertUser, raw } from '@tektum/grimoire-test-support/database';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createEmbeddingStore } from '../../src/embeddings.js';
import { createTestDatabase } from '../collections/support.js';
import type { TestDatabase } from '../collections/support.js';

// M7-T13: the SQL of the embedding store, against PostgreSQL with pgvector.
let t: TestDatabase;
let store: EmbeddingStore;
const run = (sql: string): Promise<unknown> => t.admin.query(sql);
const TENANT = 'legacy';
const M = 'model-a'; // 4 dimensions
const M2 = 'model-b'; // 3 dimensions: another model may have another length
let user: string;
let open: string;
let hidden: string;
let foreignCollection: string; // a collection of another tenant
let thirdCollection: string;

const hash = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const hex = (n: number): string => n.toString(16).padStart(2, '0').repeat(32);
const unit = (...v: number[]): Float32Array => { const n = Math.hypot(...v); return Float32Array.from(v.map((x) => x / n)); };
const chunk = (i: number, v: Float32Array | undefined, h = i + 1): ChunkRow => ({ chunkIndex: i, contentHash: hash(h), charStart: i * 10, charEnd: i * 10 + 9, tokenCount: 5, ...(v === undefined ? {} : { embedding: v }) });

beforeAll(async () => {
  t = await createTestDatabase('embeddings');
  store = createEmbeddingStore(t.app, t.ops);
  user = await insertUser(run);
  open = await insertCollection(run, { created_by: user });
  hidden = await insertCollection(run, { created_by: user });
  const seedTenant = async (id: string): Promise<string> => {
    await run(`insert into tenants (id, name) values ('${id}', '${id}') on conflict do nothing`);
    const owner = await insertUser(run, { tenant_id: id });
    return insertCollection(run, { created_by: owner, tenant_id: id });
  };
  foreignCollection = await seedTenant('T-other');
  thirdCollection = await seedTenant('T-third');
}, 120_000);
afterAll(async () => { await t?.drop(); });

interface PageOptions { readonly text?: string; readonly collection?: string; readonly tenant?: string; readonly hashByte?: number | null; readonly deleted?: boolean; readonly editedSecondsAgo?: number }
async function page(o: PageOptions = {}): Promise<string> {
  return insertPage(run, {
    collection_id: o.collection ?? open, created_by: user, tenant_id: o.tenant ?? TENANT, title: 'T', text_content: o.text ?? 'text',
    markdown_hash: o.hashByte === null ? null : raw(`decode('${hex(o.hashByte ?? 1)}', 'hex')`),
    last_edited_at: raw(`now() - interval '${String(o.editedSecondsAgo ?? 600)} seconds'`),
    ...(o.deleted === true ? { deleted_at: raw('now()'), deleted_batch: randomUUID() } : {}),
  });
}
const rows = async (id: string): Promise<{ chunk_index: number; model: string; embedding: string }[]> =>
  (await t.admin.query(`select chunk_index, model, embedding::text as embedding from page_chunks where page_id = '${id}' order by chunk_index`)) as { chunk_index: number; model: string; embedding: string }[];
const state = async (id: string) => ((await t.admin.query(`select model, status, chunk_count, attempts, error, embedded_at is not null as embedded, encode(markdown_hash, 'hex') as h from page_embedding_state where page_id = '${id}'`)) as Record<string, unknown>[])[0];

describe('replacePage', () => {
  it('writes the chunks and the state, and says stale, writing nothing, when the page changed meanwhile', async () => {
    const id = await page();
    expect(await store.replacePage(TENANT, id, hash(1), M, [chunk(0, unit(1, 0, 0, 0)), chunk(1, unit(0, 1, 0, 0))])).toBe('ok');
    expect((await rows(id)).map((r) => [r.chunk_index, r.model, r.embedding])).toEqual([[0, M, '[1,0,0,0]'], [1, M, '[0,1,0,0]']]);
    expect(await state(id)).toMatchObject({ model: M, status: 'ready', chunk_count: 2, attempts: 0, error: null, embedded: true, h: hex(1) });
    await run(`update pages set markdown_hash = decode('${hex(2)}', 'hex') where id = '${id}'`);
    expect(await store.replacePage(TENANT, id, hash(1), M, [chunk(0, unit(0, 0, 1, 0))])).toBe('stale');
    expect((await rows(id)).map((r) => r.embedding)).toEqual(['[1,0,0,0]', '[0,1,0,0]']); // untouched
    expect(await state(id)).toMatchObject({ h: hex(1) });
    expect(await store.replacePage(TENANT, randomUUID(), hash(1), M, [])).toBe('stale'); // no such page
    expect(await store.replacePage(TENANT, await page({ hashByte: null }), hash(1), M, [])).toBe('stale'); // a page with no Markdown
    expect(await store.replacePage('another-tenant', id, hash(2), M, [])).toBe('stale'); // a page of another tenant is not there
  });

  it('removes the chunks that are not in the new set, keeps the vector of an unchanged chunk, and updates its offsets', async () => {
    const id = await page();
    await store.replacePage(TENANT, id, hash(1), M, [chunk(0, unit(1, 0, 0, 0)), chunk(1, unit(0, 1, 0, 0)), chunk(2, unit(0, 0, 1, 0))]);
    expect(await store.replacePage(TENANT, id, hash(1), M, [{ ...chunk(0, undefined), charStart: 3, charEnd: 7 }, chunk(1, unit(0, 0, 0, 1), 50)])).toBe('ok');
    const after = (await t.admin.query(`select chunk_index, embedding::text as e, char_start, char_end, encode(content_hash, 'hex') as h from page_chunks where page_id = '${id}' order by chunk_index`)) as { chunk_index: number; e: string; char_start: number; char_end: number; h: string }[];
    expect(after).toEqual([
      { chunk_index: 0, e: '[1,0,0,0]', char_start: 3, char_end: 7, h: hex(1) },
      { chunk_index: 1, e: '[0,0,0,1]', char_start: 10, char_end: 19, h: hex(50) },
    ]);
    expect(await state(id)).toMatchObject({ chunk_count: 2 });
    expect(await store.replacePage(TENANT, id, hash(1), M, [])).toBe('ok'); // a page with no text: no chunk, and ready
    expect(await rows(id)).toEqual([]);
    expect(await state(id)).toMatchObject({ status: 'ready', chunk_count: 0 });
  });

  it('throws and writes nothing when a chunk has no vector to keep (another hash, another model, no row)', async () => {
    const id = await page();
    await store.replacePage(TENANT, id, hash(1), M, [chunk(0, unit(1, 0, 0, 0))]);
    await expect(store.replacePage(TENANT, id, hash(1), M, [chunk(0, undefined, 77)])).rejects.toThrow(/no stored vector/);
    await expect(store.replacePage(TENANT, id, hash(1), M2, [chunk(0, undefined)])).rejects.toThrow(/no stored vector/);
    await expect(store.replacePage(TENANT, id, hash(1), M, [chunk(0, unit(0, 1, 0, 0), 9), chunk(3, undefined)])).rejects.toThrow(/no stored vector/);
    expect((await rows(id)).map((r) => r.embedding)).toEqual(['[1,0,0,0]']); // the transaction rolled back, the first chunk's new vector too
  });

  it('replaces the chunks of another model: a page has one set and one state', async () => {
    const id = await page();
    await store.replacePage(TENANT, id, hash(1), M, [chunk(0, unit(1, 0, 0, 0)), chunk(1, unit(0, 1, 0, 0))]);
    await store.replacePage(TENANT, id, hash(1), M2, [chunk(0, unit(1, 1, 1))]);
    expect((await rows(id)).map((r) => [r.chunk_index, r.model])).toEqual([[0, M2]]);
    expect(await state(id)).toMatchObject({ model: M2 });
    expect([...(await store.existingHashes(TENANT, id, M)).keys()]).toEqual([]);
    expect([...(await store.existingHashes(TENANT, id, M2)).keys()]).toEqual([0]);
  });
});

describe('pageText', () => {
  it('gives the text and hash of a live page of the tenant, and nothing for a trashed page, one without Markdown, another tenant or no page', async () => {
    const id = await page({ hashByte: 7 });
    expect(await store.pageText(TENANT, id)).toEqual({ markdownHash: hash(7), text: 'text' });
    await run(`update pages set text_content = null where id = '${id}'`);
    expect(await store.pageText(TENANT, id)).toEqual({ markdownHash: hash(7), text: '' });
    for (const [tenant, other] of [[TENANT, await page({ deleted: true })], [TENANT, await page({ hashByte: null })], ['T-other', id], [TENANT, randomUUID()]] as const) expect(await store.pageText(tenant, other)).toBeUndefined();
  });
});

describe('saveChunks', () => {
  it('writes the chunks and nothing else, adds to an earlier save, and the final replacePage keeps them; a page that changed is stale and writes nothing', async () => {
    const id = await page({ hashByte: 3 });
    const withVector = (i: number, v: Float32Array, h = i + 1) => ({ ...chunk(i, v, h), embedding: v });
    expect(await store.saveChunks(TENANT, id, hash(3), M, [withVector(0, unit(1, 0, 0, 0))])).toBe('ok');
    expect(await store.saveChunks(TENANT, id, hash(3), M, [withVector(1, unit(0, 1, 0, 0))])).toBe('ok');
    expect((await rows(id)).map((r) => [r.chunk_index, r.embedding])).toEqual([[0, '[1,0,0,0]'], [1, '[0,1,0,0]']]);
    expect(await state(id)).toBeUndefined(); // the page is not ready: nothing marks it
    expect([...(await store.existingHashes(TENANT, id, M)).keys()]).toEqual([0, 1]);
    expect(await store.replacePage(TENANT, id, hash(3), M, [chunk(0, undefined), chunk(1, undefined), chunk(2, unit(0, 0, 1, 0))])).toBe('ok'); // two kept, one new
    expect((await rows(id)).map((r) => [r.chunk_index, r.embedding])).toEqual([[0, '[1,0,0,0]'], [1, '[0,1,0,0]'], [2, '[0,0,1,0]']]);
    expect(await state(id)).toMatchObject({ status: 'ready', chunk_count: 3 });
    await run(`update pages set markdown_hash = decode('${hex(4)}', 'hex') where id = '${id}'`);
    expect(await store.saveChunks(TENANT, id, hash(3), M, [withVector(0, unit(0, 0, 0, 1))])).toBe('stale');
    expect((await rows(id))[0]?.embedding).toBe('[1,0,0,0]');
    expect(await store.saveChunks('another-tenant', id, hash(4), M, [withVector(0, unit(0, 0, 0, 1))])).toBe('stale'); // a page of another tenant is not there
    expect(await store.saveChunks(TENANT, randomUUID(), hash(4), M, [withVector(0, unit(0, 0, 0, 1))])).toBe('stale');
  });
});

describe('existingHashes', () => {
  it('returns the stored hashes by chunk index, for the model and the tenant asked', async () => {
    const id = await page();
    await store.replacePage(TENANT, id, hash(1), M, [chunk(0, unit(1, 0, 0, 0), 11), chunk(1, unit(0, 1, 0, 0), 12)]);
    const got = await store.existingHashes(TENANT, id, M);
    expect([...got.entries()].map(([i, h]) => [i, h[0], h.length])).toEqual([[0, 11, 32], [1, 12, 32]]);
    expect(await store.existingHashes('another-tenant', id, M)).toEqual(new Map());
  });
});

describe('markFailed', () => {
  it('counts the failures of one hash and model, starts again for another, and leaves a page that changed alone', async () => {
    const id = await page({ hashByte: 5 });
    await store.markFailed(TENANT, id, hash(5), M, 'internal');
    await store.markFailed(TENANT, id, hash(5), M, 'timeout');
    expect(await state(id)).toMatchObject({ status: 'failed', attempts: 2, error: 'timeout', model: M, h: hex(5), chunk_count: 0 });
    await store.markFailed(TENANT, id, hash(5), M2, 'internal');
    expect(await state(id)).toMatchObject({ attempts: 1, model: M2 });
    await store.markFailed(TENANT, id, hash(6), M2, 'stale hash'); // the page is at hash 5
    expect(await state(id)).toMatchObject({ attempts: 1, error: 'internal' });
    await store.markFailed('another-tenant', id, hash(5), M2, 'x');
    await store.markFailed(TENANT, randomUUID(), hash(5), M2, 'x'); // no such page: nothing
    expect(await state(id)).toMatchObject({ attempts: 1 });
  });
});

describe('markFailed against a save that commits first', () => {
  it('waits for a save that holds the page, then sees the new hash and writes nothing: a failure of the old hash never lands on a page that changed', async () => {
    const id = await page({ hashByte: 5 });
    // Two connections of the superuser: the save, and the observer (the activity view hides the waits and queries of another role's sessions from everyone but a superuser).
    const save = new pg.Client({ connectionString: adminUrl(t.name) });
    const observer = new pg.Client({ connectionString: adminUrl('postgres') });
    await Promise.all([save.connect(), observer.connect()]);
    let failing: Promise<void> | undefined;
    try {
      await save.query('begin');
      await save.query(`update pages set markdown_hash = decode('${hex(6)}', 'hex') where id = '${id}'`); // a save in progress, not yet committed
      failing = store.markFailed(TENANT, id, hash(5), M, 'internal');
      await vi.waitFor(async () => {
        const r = await observer.query(`select count(*)::int as n from pg_stat_activity where datname = $1 and wait_event_type = 'Lock' and query like '%page_embedding_state%'`, [t.name]);
        expect((r.rows[0] as { n: number }).n, 'markFailed waits for the page row').toBe(1);
      }, { timeout: 20_000, interval: 50 });
      await save.query('commit');
      await failing;
      expect(await state(id)).toBeUndefined();
    } finally {
      await save.query('rollback').catch(() => undefined); // releases the lock whatever happened above, so nothing hangs the rest of the file
      await failing?.catch(() => undefined);
      await Promise.all([save.end(), observer.end()]);
    }
  }, 60_000);
});

describe('pagesNeedingEmbedding', () => {
  it('lists, oldest edit first, the live pages of the tenant that settled and have no state at their hash and model, and those that failed fewer than 3 times', async () => {
    await run(`delete from pages where tenant_id = '${TENANT}'`);
    const settled = await page({ editedSecondsAgo: 120 });
    const older = await page({ editedSecondsAgo: 300 });
    await page({ editedSecondsAgo: 10 }); // too new
    await page({ deleted: true });
    await page({ hashByte: null }); // no Markdown
    await page({ tenant: 'T-other', collection: foreignCollection });
    const ready = await page(); await store.replacePage(TENANT, ready, hash(1), M, [chunk(0, unit(1, 0, 0, 0))]);
    const failedTwice = await page(); await store.markFailed(TENANT, failedTwice, hash(1), M, 'e'); await store.markFailed(TENANT, failedTwice, hash(1), M, 'e');
    const failedThrice = await page(); for (let i = 0; i < 3; i += 1) await store.markFailed(TENANT, failedThrice, hash(1), M, 'e');
    const need = async (model = M, limit = 50) => (await store.pagesNeedingEmbedding(TENANT, model, { olderThanSeconds: 30, limit })).map((p) => p.pageId);
    const got = await need();
    expect(got).toEqual([failedTwice, older, settled]); // oldest edit first
    expect((await store.pagesNeedingEmbedding(TENANT, M, { olderThanSeconds: 30, limit: 50 }))[0]?.markdownHash).toEqual(hash(1));
    expect(await need(M, 1)).toEqual([failedTwice]);
    expect(new Set(await need(M2))).toEqual(new Set([older, settled, ready, failedTwice, failedThrice])); // another model: every page, even the one that failed 3 times with the first
    await run(`update pages set markdown_hash = decode('${hex(9)}', 'hex') where id = '${failedThrice}'`);
    expect(await need()).toContain(failedThrice); // its Markdown changed: tried again
  });
});

describe('search', () => {
  let near: string; let far: string; let secret: string; let trashed: string; let other: string; let foreign: string; let inHidden: string;
  const q = unit(1, 0, 0, 0);
  const ask = (over: Partial<Parameters<EmbeddingStore['search']>[2]> = {}, tenant = TENANT, vector = q) =>
    store.search(tenant, vector, { model: M, collectionIds: [open], limit: 10, minSimilarity: 0, ...over });
  beforeAll(async () => {
    await run(`delete from pages where tenant_id = '${TENANT}'`);
    near = await page(); far = await page(); trashed = await page({ deleted: true }); other = await page(); inHidden = await page({ collection: hidden });
    secret = inHidden;
    await store.replacePage(TENANT, near, hash(1), M, [chunk(0, unit(1, 0.1, 0, 0)), chunk(1, unit(0, 0, 1, 0))]);
    await store.replacePage(TENANT, far, hash(1), M, [chunk(0, unit(1, 1, 0, 0))]);
    await store.replacePage(TENANT, other, hash(1), M2, [chunk(0, unit(1, 0, 0))]); // another model, another length
    await run(`update pages set deleted_at = null, deleted_batch = null where id = '${trashed}'`);
    await store.replacePage(TENANT, trashed, hash(1), M, [chunk(0, q)]);
    await run(`update pages set deleted_at = now(), deleted_batch = '${randomUUID()}' where id = '${trashed}'`);
    await store.replacePage(TENANT, inHidden, hash(1), M, [chunk(0, q)]); // the exact query vector, in a collection the person may not read
    foreign = await page({ tenant: 'T-other', collection: foreignCollection });
    await store.replacePage('T-other', foreign, hash(1), M, [chunk(0, q)]);
  });

  it('returns one hit for each page, its nearest chunk, best first by cosine similarity, with the offsets', async () => {
    const hits = await ask();
    expect(hits.map((h) => [h.pageId, h.chunkIndex])).toEqual([[near, 0], [far, 0]]);
    expect(hits[0]?.similarity).toBeGreaterThan(0.99);
    expect(hits[1]?.similarity).toBeCloseTo(Math.SQRT1_2, 4);
    expect(hits[0]).toMatchObject({ charStart: 0, charEnd: 9 });
    expect(await ask({ limit: 1 })).toHaveLength(1);
  });

  it('only for pages in the collections given: a page of an unreadable collection whose vector is the exact query vector is not returned, nor a trashed page, another model, another tenant', async () => {
    const ids = (await ask()).map((h) => h.pageId);
    for (const hidden_ of [secret, trashed, other, foreign]) expect(ids).not.toContain(hidden_);
    expect((await ask({ collectionIds: [open, hidden] })).map((h) => h.pageId)).toContain(secret);
    expect(await ask({ collectionIds: [] })).toEqual([]);
    expect(await ask({ model: M2 }, TENANT, unit(1, 0, 0).slice(0, 3))).toHaveLength(1);
  });

  it('honours collectionId and minSimilarity', async () => {
    expect(await ask({ collectionIds: [open, hidden], collectionId: hidden })).toHaveLength(1);
    expect(await ask({ collectionIds: [open], collectionId: hidden })).toEqual([]);
    expect((await ask({ minSimilarity: 0.9 })).map((h) => h.pageId)).toEqual([near]);
    expect(await ask({ minSimilarity: 1.0001 })).toEqual([]);
  });

  it('is an exact scan: no approximate index exists and the plan names none', async () => {
    const indexes = (await t.admin.query(`select indexdef from pg_indexes where tablename = 'page_chunks'`)) as { indexdef: string }[];
    expect(indexes.map((i) => i.indexdef).join('\n')).not.toMatch(/hnsw|ivfflat/i);
    const plan = (await t.admin.query(`explain select c.page_id from page_chunks c join pages p on p.id = c.page_id where c.model = '${M}' order by c.embedding <=> '[1,0,0,0]'::vector limit 10`)) as Record<string, string>[];
    expect(plan.map((r) => Object.values(r)[0]).join('\n')).not.toMatch(/hnsw|ivfflat/i);
  });

  it('reads the text of the best chunk by code points, and the edit time of the page, in the same statement; a page that was filtered out has no text in the answer', async () => {
    const MARK = 'hiddenmarker-5531';
    const emoji = await page({ text: `🙂🙂 intro words. the matching passage is here. tail`, editedSecondsAgo: 120 });
    const start = Array.from('🙂🙂 intro words. ').length; // code points: PostgreSQL's substr counts them, not UTF-16 units
    await store.replacePage(TENANT, emoji, hash(1), M, [{ ...chunk(0, unit(1, 0, 0, 0)), charStart: start, charEnd: start + Array.from('the matching passage is here').length }]);
    const secretPage = await page({ collection: hidden, text: `${MARK} should never be read` });
    await store.replacePage(TENANT, secretPage, hash(1), M, [{ ...chunk(0, unit(1, 0, 0, 0)), charStart: 0, charEnd: 20 }]);
    const hits = await ask({ minSimilarity: 0.99 });
    const mine = hits.find((h) => h.pageId === emoji);
    expect(mine?.text).toBe('the matching passage is here');
    const expected = ((await t.admin.query(`select (extract(epoch from coalesce(last_edited_at, updated_at)) * 1000000)::bigint as us from pages where id = '${emoji}'`)) as { us: string }[])[0];
    expect(mine?.editedAt).toBe(Number(expected?.us));
    const meta = ((await t.admin.query(`select title, url_id, collection_id from pages where id = '${emoji}'`)) as { title: string; url_id: string; collection_id: string }[])[0];
    expect([mine?.title, mine?.urlId, mine?.collectionId]).toEqual([meta?.title, meta?.url_id, meta?.collection_id]); // from the same row as the text
    expect(JSON.stringify(hits)).not.toContain(MARK);
    await store.replacePage(TENANT, emoji, hash(1), M, [{ ...chunk(0, unit(1, 0, 0, 0)), charStart: 0, charEnd: 99_999 }]);
    expect((await ask({ minSimilarity: 0.99 })).find((h) => h.pageId === emoji)?.text).toBe('🙂🙂 intro words. the matching passage is here. tail'); // never past the text
    await run(`update pages set text_content = null where id = '${emoji}'`);
    expect((await ask({ minSimilarity: 0.99 })).find((h) => h.pageId === emoji)?.text).toBe(''); // a page with no text has an empty passage
  });
});

describe('counts', () => {
  it('counts the chunks of the model and the pages ready, failed and pending at their current hash, over every tenant', async () => {
    await run(`delete from pages where true`);
    const a = await page(); const b = await page(); const c = await page(); const d = await page({ tenant: 'T-third', collection: thirdCollection }); await page({ deleted: true }); await page({ hashByte: null });
    await store.replacePage(TENANT, a, hash(1), M, [chunk(0, unit(1, 0, 0, 0)), chunk(1, unit(0, 1, 0, 0))]);
    await store.markFailed(TENANT, b, hash(1), M, 'e');
    await store.replacePage(TENANT, c, hash(1), M2, [chunk(0, unit(1, 1, 1))]); // ready for another model: pending for this one
    void d;
    expect(await store.counts(M)).toEqual({ chunks: 2, pagesReady: 1, pagesFailed: 1, pagesPending: 2 });
    expect(await store.counts(M2)).toEqual({ chunks: 1, pagesReady: 1, pagesFailed: 0, pagesPending: 3 });
    expect(await store.counts('no-such-model')).toEqual({ chunks: 0, pagesReady: 0, pagesFailed: 0, pagesPending: 4 });
  });
});

describe('what the foreign keys do', () => {
  it('a purge of the page removes its chunks and its state', async () => {
    const id = await page();
    await store.replacePage(TENANT, id, hash(1), M, [chunk(0, unit(1, 0, 0, 0))]);
    await run(`delete from pages where id = '${id}'`);
    expect(await rows(id)).toEqual([]);
    expect(await state(id)).toBeUndefined();
  });

  it('a 31-byte hash is refused', async () => {
    const id = await page();
    await expect(t.app.query(`insert into page_chunks (page_id, tenant_id, chunk_index, model, content_hash, char_start, char_end, token_count, embedding) values ($1, $2, 0, 'm', $3, 0, 1, 1, '[1,0]')`, [id, TENANT, Buffer.alloc(31)])).rejects.toThrow();
  });
});
