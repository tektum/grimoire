import { describe, expect, it } from 'vitest';
import type { ChunkRow } from '../../src/ports/embedding-store.js';
import { FakeEmbedder, vectorOf } from '../../src/testing/fake-embedder.js';
import { FakeEmbeddingStore } from '../../src/testing/fake-embedding-store.js';

const hash = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const chunk = (i: number, text: string, dims = 8): ChunkRow => ({ chunkIndex: i, contentHash: hash(i + 1), charStart: i * 10, charEnd: i * 10 + text.length, tokenCount: 3, embedding: vectorOf(`passage: ${text}`, dims) });
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
    expect(await need()).toEqual(['p1']);
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
    expect((await ask()).map((h) => `${h.pageId}:${String(h.chunkIndex)}`)).toEqual(['p1:0', 'p2:0', 'p1:1']);
    expect((await ask())[0]).toMatchObject({ charStart: 0, charEnd: 24, similarity: expect.closeTo(1, 5) });
    expect((await ask({ collectionIds: ['open'] })).map((h) => h.pageId)).toEqual(['p1', 'p1']);
    expect((await ask({ collectionId: 'closed' })).map((h) => h.pageId)).toEqual(['p2']);
    expect((await ask({ collectionIds: ['open'], collectionId: 'closed' }))).toEqual([]);
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
