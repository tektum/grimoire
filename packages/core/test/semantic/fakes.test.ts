import { describe, expect, it } from 'vitest';
import type { ChunkRow } from '../../src/ports/embedding-store.js';
import { FakeEmbedder, vectorOf } from '../../src/testing/fake-embedder.js';
import { FakeEmbeddingStore } from '../../src/testing/fake-embedding-store.js';

const hash = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const chunk = (i: number, text: string, dims = 8): ChunkRow => ({
  chunkIndex: i,
  contentHash: hash(i + 1),
  charStart: i * 10,
  charEnd: i * 10 + text.length,
  tokenCount: 3,
  embedding: vectorOf(`passage: ${text}`, dims),
});
const NOW = 1_000_000_000;

describe('FakeEmbedder', () => {
  it('gives texts that share words nearer vectors than texts that share none, and records the prefixed texts', async () => {
    const e = new FakeEmbedder({ dims: 64 });
    const r = await e.embedPassages(['quarterly planning meeting notes', 'notes of the quarterly planning meeting', 'recipe for tomato soup']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const dot = (a: Float32Array, b: Float32Array) => a.reduce((s, x, i) => s + x * (b[i] as number), 0);
    expect(dot(r.vectors[0] as Float32Array, r.vectors[1] as Float32Array)).toBeGreaterThan(dot(r.vectors[0] as Float32Array, r.vectors[2] as Float32Array));
    expect(e.calls[0]?.texts[2]).toBe('passage: recipe for tomato soup');
    await e.embedQuery('soup');
    expect(e.calls[1]).toEqual({ kind: 'query', texts: ['query: soup'] });
  });

  it('plays a loading and a gone model, one scripted failure, and a text with no words', async () => {
    const e = new FakeEmbedder({ dims: 4, threads: 3 });
    e.setStatus('loading');
    expect(e.status()).toBe('loading');
    expect(await e.embedQuery('x')).toEqual({ ok: false, reason: 'unavailable' });
    e.setStatus('ready');
    e.failNext('timeout');
    expect(await e.embedQuery('x')).toEqual({ ok: false, reason: 'timeout' });
    const empty = await e.embedPassages(['   ']);
    expect(empty.ok && empty.vectors[0]?.length).toBe(4);
    expect(e.stats()).toEqual({ threads: 3, queued: 0, chunksPerMinute: 0 });
  });
});

describe('FakeEmbeddingStore', () => {
  function world() {
    const store = new FakeEmbeddingStore(() => NOW);
    store.seedPage({ id: 'p1', collectionId: 'open', markdownHash: hash(1), editedAt: NOW - 120_000 });
    store.seedPage({ id: 'p2', collectionId: 'closed', markdownHash: hash(2), editedAt: NOW - 300_000 });
    store.seedPage({ id: 'p3', collectionId: 'open', markdownHash: hash(3), editedAt: NOW - 10_000 });
    store.seedPage({ id: 'x1', collectionId: 'open', markdownHash: hash(9), editedAt: NOW - 500_000, tenantId: 'other' });
    return store;
  }

  it('lists pages with no state at their current hash, oldest first, not too new, not trashed, in the tenant, and not again once failed', async () => {
    const store = world();
    const need = async () => (await store.pagesNeedingEmbedding('legacy', 'm', { olderThanSeconds: 60, limit: 10 })).map((p) => p.pageId);
    expect(await need()).toEqual(['p2', 'p1']);
    expect(await store.pagesNeedingEmbedding('legacy', 'm', { olderThanSeconds: 60, limit: 1 })).toHaveLength(1);
    await store.markFailed('legacy', 'p2', hash(2), 'm', 'too-long');
    await store.markFailed('legacy', 'p2', hash(2), 'm', 'too-long');
    expect(await need()).toEqual(['p2', 'p1']); // two failures: tried again
    await store.markFailed('legacy', 'p2', hash(2), 'm', 'too-long');
    expect(await need()).toEqual(['p1']); // three: not again until the Markdown changes
    store.editPage('p2', hash(22), NOW - 200_000);
    expect(await need()).toEqual(['p2', 'p1']);
    store.trashPage('p1');
    expect(await need()).toEqual(['p2']);
    expect(await store.pagesNeedingEmbedding('legacy', 'another-model', { olderThanSeconds: 60, limit: 10 })).toHaveLength(1);
  });

  it('stores a page ready at its hash, replaces its chunks, and says stale when the page changed meanwhile', async () => {
    const store = world();
    expect(await store.replacePage('legacy', 'p1', hash(1), 'm', [chunk(0, 'alpha'), chunk(1, 'beta')])).toBe('ok');
    expect([...(await store.existingHashes('legacy', 'p1', 'm')).keys()]).toEqual([0, 1]);
    expect(await store.replacePage('legacy', 'p1', hash(1), 'm', [chunk(0, 'alpha')])).toBe('ok');
    expect([...(await store.existingHashes('legacy', 'p1', 'm')).keys()]).toEqual([0]);
    store.editPage('p1', hash(11), NOW);
    expect(await store.replacePage('legacy', 'p1', hash(1), 'm', [chunk(0, 'old')])).toBe('stale');
    expect(store.stored('p1', 'm').chunks).toHaveLength(1);
    expect(await store.replacePage('legacy', 'nope', hash(1), 'm', [])).toBe('stale');
    expect(await store.replacePage('other', 'p1', hash(11), 'm', [])).toBe('stale'); // a page of another tenant is not there
    expect(await store.existingHashes('other', 'p1', 'm')).toEqual(new Map());
  });

  it('counts the attempts of a failure at one hash, restarts them when the page changed, and ignores a failure of a stale hash', async () => {
    const store = world();
    await store.markFailed('legacy', 'p1', hash(1), 'm', 'internal');
    await store.markFailed('legacy', 'p1', hash(1), 'm', 'internal');
    expect(store.stored('p1', 'm').state).toMatchObject({ status: 'failed', attempts: 2, error: 'internal' });
    await store.markFailed('legacy', 'p1', hash(7), 'm', 'stale hash');
    expect(store.stored('p1', 'm').state?.attempts).toBe(2);
    store.editPage('p1', hash(11), NOW);
    await store.markFailed('legacy', 'p1', hash(11), 'm', 'internal');
    expect(store.stored('p1', 'm').state?.attempts).toBe(1);
    await store.markFailed('legacy', 'nope', hash(1), 'm', 'x');
  });

  it('searches the readable collections of the tenant, best first, over a floor, without trashed pages or other dimensions', async () => {
    const store = world();
    store.seedPage({ id: 'p4', collectionId: 'open', markdownHash: hash(4), editedAt: 0 });
    await store.replacePage('legacy', 'p1', hash(1), 'm', [chunk(0, 'quarterly planning notes'), chunk(1, 'tomato soup recipe')]);
    await store.replacePage('legacy', 'p2', hash(2), 'm', [chunk(0, 'quarterly planning notes')]);
    await store.replacePage('legacy', 'p4', hash(4), 'm', [chunk(0, 'quarterly planning notes', 4)]); // another dimension: not comparable, skipped
    await store.replacePage('other', 'x1', hash(9), 'm', [chunk(0, 'quarterly planning notes')]);
    const q = vectorOf('passage: quarterly planning notes', 8);
    const ask = (over: object = {}) => store.search('legacy', q, { model: 'm', collectionIds: ['open', 'closed'], limit: 10, minSimilarity: 0, ...over });
    expect((await ask()).map((h) => `${h.pageId}:${String(h.chunkIndex)}`)).toEqual(['p1:0', 'p2:0']); // one hit for each page: its best chunk
    expect((await ask())[0]).toMatchObject({ charStart: 0, charEnd: 24, similarity: expect.closeTo(1, 5) });
    expect((await ask({ collectionIds: ['open'] })).map((h) => h.pageId)).toEqual(['p1']);
    expect((await ask({ collectionId: 'closed' })).map((h) => h.pageId)).toEqual(['p2']);
    expect(await ask({ collectionIds: ['open'], collectionId: 'closed' })).toEqual([]);
    expect((await ask({ minSimilarity: 0.99 })).map((h) => h.pageId)).toEqual(['p1', 'p2']);
    expect(await ask({ limit: 1 })).toHaveLength(1);
    expect(await ask({ model: 'other-model' })).toEqual([]);
    store.trashPage('p2');
    expect((await ask()).map((h) => h.pageId)).not.toContain('p2');
    expect(await store.search('nobody', q, { model: 'm', collectionIds: ['open'], limit: 5, minSimilarity: 0 })).toEqual([]);
  });

  it('counts chunks and pages by state over every tenant', async () => {
    const store = world();
    await store.replacePage('legacy', 'p1', hash(1), 'm', [chunk(0, 'a'), chunk(1, 'b')]);
    await store.markFailed('legacy', 'p2', hash(2), 'm', 'internal');
    store.trashPage('p3');
    expect(await store.counts('m')).toEqual({ chunks: 2, pagesReady: 1, pagesFailed: 1, pagesPending: 1 }); // p3 is trashed, x1 (another tenant) is pending
    store.seedPage({ id: 'p5', collectionId: 'open', markdownHash: null });
    expect((await store.counts('m')).pagesPending).toBe(1);
  });
});

describe('FakeEmbeddingStore, the text of a page', () => {
  it('gives the text and hash of a live page of the tenant, and nothing for a trashed page, one without Markdown, another tenant or no page', async () => {
    const store = new FakeEmbeddingStore(() => NOW);
    store.seedPage({ id: 'p1', collectionId: 'open', markdownHash: hash(1), text: 'hello world' });
    store.seedPage({ id: 'p2', collectionId: 'open', markdownHash: null });
    store.seedPage({ id: 'p3', collectionId: 'open', markdownHash: hash(3) });
    store.trashPage('p3');
    expect(await store.pageText('legacy', 'p1')).toEqual({ markdownHash: hash(1), text: 'hello world' });
    store.editPage('p1', hash(2), NOW, 'changed text');
    expect(await store.pageText('legacy', 'p1')).toEqual({ markdownHash: hash(2), text: 'changed text' });
    for (const [tenant, id] of [
      ['legacy', 'p2'],
      ['legacy', 'p3'],
      ['other', 'p1'],
      ['legacy', 'nope'],
    ] as const)
      expect(await store.pageText(tenant, id)).toBeUndefined();
  });
});

describe('FakeEmbeddingStore, progress saved before the page is whole', () => {
  it('saves chunks without touching the others or the state, adds to what an earlier save stored, and lets the final write keep them', async () => {
    const store = new FakeEmbeddingStore(() => NOW);
    store.seedPage({ id: 'p1', collectionId: 'open', markdownHash: hash(1), editedAt: 0 });
    expect(await store.saveChunks('legacy', 'p1', hash(1), 'm', [{ ...chunk(0, 'alpha'), embedding: vectorOf('passage: alpha', 8) }])).toBe('ok');
    expect(await store.saveChunks('legacy', 'p1', hash(1), 'm', [{ ...chunk(1, 'beta'), embedding: vectorOf('passage: beta', 8) }])).toBe('ok');
    expect(store.stored('p1', 'm').chunks.map((c) => c.chunkIndex)).toEqual([0, 1]);
    expect(store.stored('p1', 'm').state).toBeUndefined(); // not ready: the page is not whole yet
    expect([...(await store.existingHashes('legacy', 'p1', 'm')).keys()]).toEqual([0, 1]);
    const keep = (i: number, text: string): ChunkRow => ({ chunkIndex: i, contentHash: hash(i + 1), charStart: i * 10, charEnd: i * 10 + text.length, tokenCount: 3 }); // no vector: the stored one is kept
    expect(await store.replacePage('legacy', 'p1', hash(1), 'm', [keep(0, 'alpha'), keep(1, 'beta')])).toBe('ok');
    expect(store.stored('p1', 'm').state).toMatchObject({ status: 'ready' });
  });

  it('says stale and writes nothing when the page changed, and writes nothing for a page of another tenant or one that is gone', async () => {
    const store = new FakeEmbeddingStore(() => NOW);
    store.seedPage({ id: 'p1', collectionId: 'open', markdownHash: hash(1), editedAt: 0 });
    store.editPage('p1', hash(2), 0);
    const row = { ...chunk(0, 'alpha'), embedding: vectorOf('passage: alpha', 8) };
    expect(await store.saveChunks('legacy', 'p1', hash(1), 'm', [row])).toBe('stale');
    expect(await store.saveChunks('other', 'p1', hash(2), 'm', [row])).toBe('stale');
    expect(await store.saveChunks('legacy', 'nope', hash(2), 'm', [row])).toBe('stale');
    expect(store.stored('p1', 'm').chunks).toEqual([]);
  });

  it('upserts by index as the SQL does: the rows of another model at other indexes stay and stay visible to that model, a row at the same index is replaced, and replacePage then removes what it does not list', async () => {
    const store = new FakeEmbeddingStore(() => NOW);
    store.seedPage({ id: 'p1', collectionId: 'open', markdownHash: hash(1), editedAt: 0 });
    const row = (i: number, text: string) => ({ ...chunk(i, text), embedding: vectorOf(`passage: ${text}`, 8) });
    await store.saveChunks('legacy', 'p1', hash(1), 'm1', [row(0, 'alpha'), row(1, 'beta'), row(2, 'gamma')]);
    await store.saveChunks('legacy', 'p1', hash(1), 'm2', [row(0, 'delta'), row(1, 'epsilon')]); // a partial run of another model
    expect(store.stored('p1', 'm1').chunks.map((c) => c.chunkIndex)).toEqual([2]); // 0 and 1 became m2's
    expect(store.stored('p1', 'm2').chunks.map((c) => c.chunkIndex)).toEqual([0, 1]);
    expect([...(await store.existingHashes('legacy', 'p1', 'm1')).keys()]).toEqual([2]);
    expect(await store.counts('m1')).toMatchObject({ chunks: 1 });
    expect(await store.counts('m2')).toMatchObject({ chunks: 2 });
    const keep = (i: number, text: string): ChunkRow => ({ chunkIndex: i, contentHash: hash(i + 1), charStart: i * 10, charEnd: i * 10 + text.length, tokenCount: 3 });
    await store.replacePage('legacy', 'p1', hash(1), 'm2', [keep(0, 'delta'), keep(1, 'epsilon')]); // the finishing write: m1's row at 2 goes, as the SQL deletes what is not listed
    expect(store.stored('p1', 'm1').chunks).toEqual([]);
    expect(store.stored('p1', 'm2').chunks.map((c) => c.chunkIndex)).toEqual([0, 1]);
  });
});

describe('FakeEmbeddingStore, chunks that did not change', () => {
  it('keeps the stored vector of a chunk given without one, updates its offsets, and throws when there is none to keep', async () => {
    const store = new FakeEmbeddingStore(() => NOW);
    store.seedPage({ id: 'p1', collectionId: 'open', markdownHash: hash(1), editedAt: 0 });
    const first = chunk(0, 'alpha');
    await store.replacePage('legacy', 'p1', hash(1), 'm', [first, chunk(1, 'beta')]);
    const unchanged: ChunkRow = { chunkIndex: 0, contentHash: first.contentHash, charStart: 5, charEnd: 9, tokenCount: first.tokenCount };
    await store.replacePage('legacy', 'p1', hash(1), 'm', [unchanged]);
    const [kept] = store.stored('p1', 'm').chunks;
    expect(kept?.embedding).toEqual(first.embedding);
    expect([kept?.charStart, kept?.charEnd]).toEqual([5, 9]);
    expect(store.stored('p1', 'm').chunks).toHaveLength(1);
    await expect(store.replacePage('legacy', 'p1', hash(1), 'm', [{ ...unchanged, contentHash: hash(99) }])).rejects.toThrow(/no stored vector/);
    await expect(store.replacePage('legacy', 'p1', hash(1), 'm2', [unchanged])).rejects.toThrow(/no stored vector/); // another model: nothing to keep
    expect(store.stored('p1', 'm').chunks).toHaveLength(1);
  });
});

describe('FakeEmbeddingStore, one state per page', () => {
  it('a write for another model replaces the page chunks and state, as the tables do', async () => {
    const store = new FakeEmbeddingStore(() => NOW);
    store.seedPage({ id: 'p1', collectionId: 'open', markdownHash: hash(1), editedAt: 0 });
    await store.replacePage('legacy', 'p1', hash(1), 'm1', [chunk(0, 'alpha')]);
    await store.replacePage('legacy', 'p1', hash(1), 'm2', [chunk(0, 'beta')]);
    expect(store.stored('p1', 'm1')).toEqual({ chunks: [], state: undefined });
    expect(await store.existingHashes('legacy', 'p1', 'm1')).toEqual(new Map());
    expect(await store.counts('m1')).toMatchObject({ chunks: 0, pagesReady: 0, pagesPending: 1 });
    expect(await store.pagesNeedingEmbedding('legacy', 'm1', { olderThanSeconds: 1, limit: 5 })).toHaveLength(1);
    expect(await store.search('legacy', vectorOf('passage: beta', 8), { model: 'm1', collectionIds: ['open'], limit: 5, minSimilarity: 0 })).toEqual([]);
    expect(await store.counts('m2')).toMatchObject({ chunks: 1, pagesReady: 1 });
  });
});

describe('FakeEmbeddingStore, what a hit carries', () => {
  it('gives the text of the chunk, read by code points from the page, and the edit time of the page in microseconds, only for the pages it returns', async () => {
    const store = new FakeEmbeddingStore(() => NOW);
    const text = '🙂 first part of the page. second part here.';
    store.seedPage({ id: 'p1', collectionId: 'open', markdownHash: hash(1), editedAt: 1234, text, title: 'Plans', urlId: 'plans-1' });
    store.seedPage({ id: 'p2', collectionId: 'closed', markdownHash: hash(2), editedAt: 1, text: 'secret chunk text' });
    const start = Array.from('🙂 first part of the page. ').length; // code points, not UTF-16 units
    await store.replacePage('legacy', 'p1', hash(1), 'm', [
      { ...chunk(0, 'x'), charStart: 0, charEnd: 25 },
      { ...chunk(1, 'second part here'), charStart: start, charEnd: start + 17 },
    ]);
    await store.replacePage('legacy', 'p2', hash(2), 'm', [{ ...chunk(0, 'second part here'), charStart: 0, charEnd: 17 }]);
    const hits = await store.search('legacy', vectorOf('passage: second part here', 8), { model: 'm', collectionIds: ['open'], limit: 5, minSimilarity: 0 });
    expect(hits.map((h) => [h.pageId, h.chunkIndex, h.text, h.editedAt, h.title, h.urlId, h.collectionId])).toEqual([['p1', 1, 'second part here.', 1_234_000, 'Plans', 'plans-1', 'open']]);
    expect(JSON.stringify(hits)).not.toContain('secret'); // the text of a page that was filtered out is never read
  });
});
