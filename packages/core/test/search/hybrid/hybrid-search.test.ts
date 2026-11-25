import { describe, expect, it } from 'vitest';
import type { ChunkHit, EmbeddingStore } from '../../../src/ports/embedding-store.js';
import type { Logger } from '../../../src/ports/logger.js';
import { decodeHybridCursor, decodeSearchCursor, encodeSearchCursor, InvalidSearchCursor } from '../../../src/search/cursor.js';
import { MEANING_ONLY_MAX } from '../../../src/search/hybrid.js';
import { HybridContinuationUnavailable, hybridSearch, type HybridDeps, type SemanticSearch } from '../../../src/search/hybrid-search.js';
import { modelKey } from '../../../src/semantic/model-key.js';
import { FakeEmbedder } from '../../../src/testing/fake-embedder.js';
import { FakeSearchRepo } from '../../../src/testing/fake-search-repo.js';

const TENANT = 'legacy';
const COLLECTION = '00000000-0000-4000-8000-0000000000c1';
const id = (kind: string, n: number): string => `${kind}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function setup(over: { enabled?: boolean; candidates?: number; minSimilarity?: number; queryTimeoutMs?: number } = {}) {
  const fullText = new FakeSearchRepo();
  const embedder = new FakeEmbedder({ name: 'multilingual-e5-base', version: 'int8@abcd1234', dims: 8 });
  const asked: { vector: Float32Array; options: Parameters<EmbeddingStore['search']>[2]; tenantId: string }[] = [];
  const state: { chunks: ChunkHit[]; fail: boolean } = { chunks: [], fail: false };
  const store = {
    search: (tenantId, vector, options) => {
      asked.push({ vector, options, tenantId });
      return state.fail ? Promise.reject(new Error('the statement failed')) : Promise.resolve(state.chunks.slice(0, options.limit));
    },
  } as EmbeddingStore;
  const logs: { event: string; fields: unknown }[] = [];
  const log = { debug: (event: string, fields: unknown) => logs.push({ event, fields }), info() {}, warn() {}, error() {}, child: () => log } as Logger;
  const semantic: SemanticSearch = {
    embedder,
    store,
    settings: { enabled: over.enabled ?? true, queryTimeoutMs: over.queryTimeoutMs ?? 1500, minSimilarity: over.minSimilarity ?? 0, candidates: over.candidates ?? 100 },
  };
  const deps: HybridDeps = { fullText, semantic, log };
  const word = (pageId: string, title: string, updatedAt = 1000): void =>
    fullText.seed({ tenantId: TENANT, pageId, urlId: `u-${title}`, title, collectionId: COLLECTION, snippet: { text: `the ${title} words`, ranges: [[4, 4 + title.length]] }, partial: false, updatedAt, rank: 0.5 });
  const meaning = (pageId: string, title: string, text: string, similarity = 0.8, editedAt = 1_000_000): ChunkHit => ({
    pageId,
    chunkIndex: 0,
    charStart: 0,
    charEnd: text.length,
    similarity,
    text,
    editedAt,
    title,
    urlId: `u-${title}`,
    collectionId: COLLECTION,
  });
  const request = (query = 'a search', over2: object = {}) => ({ tenantId: TENANT, collectionIds: [COLLECTION], query, limit: 20, ...over2 });
  return { deps, fullText, embedder, state, asked, logs, word, meaning, request };
}

describe('the hybrid answer', () => {
  it('returns a page found by words and a page found only by meaning, with the passage of the second and the highlighted snippet of the first', async () => {
    const s = setup();
    const A = id('a', 1);
    const B = id('b', 2);
    s.word(A, 'Alpha', 2000); // the same score as B's (rank 1 in its list): the later edit decides
    const long = `${'The quarterly plan covers hiring and budget. '.repeat(50)}END`; // 2,300 characters
    const raw = `Plan\n\nfor   next year\u0001 ${long}`;
    s.state.chunks = [s.meaning(B, 'Beta', raw)];
    const page = await hybridSearch(s.deps, s.request());
    expect(page.semantic).toBe(true);
    expect(page.hits.map((h) => h.pageId)).toEqual([A, B]);
    const [a, b] = page.hits;
    expect(a?.snippet.ranges).toEqual([[4, 9]]);
    expect(a?.matchedPassage).toBeUndefined(); // found by words only
    expect(b?.matchedPassage?.text.length).toBeLessThanOrEqual(300);
    expect(b?.matchedPassage?.text.startsWith('Plan for next year The quarterly plan')).toBe(true);
    const normalized = raw.replace(/\u0001/g, '').replace(/\s+/g, ' ');
    expect(normalized.startsWith(b?.matchedPassage?.text ?? '?')).toBe(true);
    expect(normalized[b?.matchedPassage?.text.length ?? 0]).toBe(' '); // cut at a word boundary: a space follows it in the text
    expect(b?.snippet).toEqual({ text: b?.matchedPassage?.text.slice(0, 160), ranges: [] });
    expect([b?.title, b?.urlId, b?.collectionId, b?.partial]).toEqual(['Beta', 'u-Beta', COLLECTION, false]);
    expect(b?.updatedAt).toBe(1000); // microseconds to milliseconds
  });

  it('gives a page found by both its words and its passage, and ranks it above a page found by one', async () => {
    const s = setup();
    const both = id('a', 1);
    const wordsOnly = id('a', 2);
    const meaningOnly = id('b', 3);
    s.word(wordsOnly, 'Words', 9000);
    s.word(both, 'Both', 8000);
    s.state.chunks = [s.meaning(both, 'Both', 'both passage', 0.9), s.meaning(meaningOnly, 'Meaning', 'meaning passage', 0.8)];
    const page = await hybridSearch(s.deps, s.request());
    expect(page.hits.map((h) => h.pageId)).toEqual([both, wordsOnly, meaningOnly]);
    expect(page.hits[0]?.snippet.ranges).toEqual([[4, 8]]); // its full-text snippet stays
    expect(page.hits[0]?.matchedPassage).toEqual({ text: 'both passage' }); // and it has the passage of its best chunk
    expect(page.hits[0]?.rank).toBeCloseTo(1 / 62 + 1 / 61, 10);
  });

  it("asks the store for the caller's collections, the collection asked for, the candidates and the minimum, with the key of the model in use, and the embedder for the query within the time of the setting", async () => {
    const s = setup({ candidates: 40, minSimilarity: 0.25, queryTimeoutMs: 777 });
    await hybridSearch(s.deps, s.request('needle', { collectionId: COLLECTION }));
    expect(s.asked).toHaveLength(1);
    expect(s.asked[0]?.tenantId).toBe(TENANT);
    expect(s.asked[0]?.options).toEqual({ model: modelKey(s.embedder.model), collectionIds: [COLLECTION], collectionId: COLLECTION, limit: 40, minSimilarity: 0.25 });
    expect(s.asked[0]?.options.model).toBe('multilingual-e5-base-int8@abcd1234');
    expect(s.fullText.requests[0]).toMatchObject({ limit: 40, query: 'needle', collectionId: COLLECTION });
    expect(s.embedder.calls.map((c) => [c.kind, c.texts])).toEqual([['query', ['query: needle']]]); // the fake records what the adapter would send: with the prefix
  });
});

describe('a search that matches nothing', () => {
  it('returns at most five pages, all found only by meaning and each with its passage, however many the store hands over', async () => {
    const s = setup();
    s.state.chunks = Array.from({ length: 100 }, (_, i) => s.meaning(id('b', i), `Page ${String(i)}`, `passage ${String(i)}`, 0.8 - i / 1000));
    const page = await hybridSearch(s.deps, s.request('purple elephants dancing quarterly'));
    expect(MEANING_ONLY_MAX).toBe(5);
    expect(page.hits).toHaveLength(5);
    expect(page.hits.map((h) => h.pageId)).toEqual([0, 1, 2, 3, 4].map((i) => id('b', i))); // the nearest five
    for (const h of page.hits) {
      expect(h.matchedPassage?.text).toMatch(/^passage \d$/);
      expect(h.snippet.ranges).toEqual([]);
    }
    expect(page.nextCursor).toBeUndefined();
    expect(page.semantic).toBe(true);
  });

  it('still returns the page that answers a paraphrase, first', async () => {
    const s = setup();
    s.state.chunks = [
      s.meaning(id('b', 1), 'Leave policy', 'Employees accrue twenty-five days of paid leave each year.', 0.88),
      ...Array.from({ length: 30 }, (_, i) => s.meaning(id('b', i + 2), `Other ${String(i)}`, `other ${String(i)}`, 0.78)),
    ];
    const page = await hybridSearch(s.deps, s.request('how many holidays do I get'));
    expect(page.hits[0]?.pageId).toBe(id('b', 1));
    expect(page.hits[0]?.matchedPassage?.text).toBe('Employees accrue twenty-five days of paid leave each year.');
    expect(page.hits).toHaveLength(5);
  });

  it('never drops a page found by words to make room: all the pages the words found, and five by meaning, in the order of their fused scores', async () => {
    const s = setup();
    for (let i = 0; i < 8; i += 1) s.word(id('a', i), `Word ${String(i)}`, 5000 - i);
    s.state.chunks = Array.from({ length: 20 }, (_, i) => s.meaning(id('b', i), `Meaning ${String(i)}`, `m ${String(i)}`, 0.9 - i / 1000));
    const page = await hybridSearch(s.deps, s.request());
    expect(page.hits.filter((h) => h.pageId.startsWith('a'))).toHaveLength(8);
    expect(page.hits.filter((h) => h.pageId.startsWith('b'))).toHaveLength(5);
    // Fusion interleaves: the nearest page by meaning ties the first page by words (both are rank 1 of their list), and the cap drops the sixth and the rest of the meaning-only pages.
    const scores = page.hits.map((h) => h.rank);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(page.hits.map((h) => h.pageId)).not.toContain(id('b', 5));
  });
});

describe('when the semantic part cannot answer', () => {
  const cases: [string, (s: ReturnType<typeof setup>) => void, string][] = [
    ['the setting is off', (s) => void (s.deps.semantic = { ...(s.deps.semantic as SemanticSearch), settings: { ...(s.deps.semantic as SemanticSearch).settings, enabled: false } }), 'off'],
    ['there is no embedder', (s) => void ((s.deps as { semantic?: SemanticSearch }).semantic = undefined), 'off'],
    ['the model is not ready', (s) => s.embedder.setStatus('loading'), 'not-ready'],
    ['the model is gone', (s) => s.embedder.setStatus('unavailable'), 'not-ready'],
    ['the query is not embedded in time', (s) => s.embedder.failNext('timeout'), 'embed-failed'],
    ['the query cannot be embedded', (s) => s.embedder.failNext('internal'), 'embed-failed'],
    ['the statement throws', (s) => void (s.state.fail = true), 'statement-failed'],
  ];
  it.each(cases)('answers with the full-text search alone, with its own cursor, when %s', async (_name, arrange, reason) => {
    const s = setup();
    for (let i = 0; i < 30; i += 1) s.word(id('a', i), `Word ${String(i)}`);
    s.state.chunks = [s.meaning(id('b', 1), 'Meaning', 'only by meaning')];
    arrange(s);
    const page = await hybridSearch(s.deps, s.request('words', { limit: 10 }));
    expect(page.semantic).toBe(false);
    expect(page.hits).toHaveLength(10); // the page that was asked for, not the 100 candidates
    expect(page.hits.some((h) => h.matchedPassage !== undefined || h.pageId.startsWith('b'))).toBe(false);
    expect(s.fullText.requests.at(-1)).toMatchObject({ limit: 10, query: 'words' });
    expect(s.logs).toEqual([{ event: 'search.semantic_fallback', fields: { reason } }]);
    expect(JSON.stringify(s.logs)).not.toContain('words'); // what was searched for is never logged
  });

  it('is the full-text answer exactly when the semantic part was never asked: the same request goes to the repository', async () => {
    const s = setup({ enabled: false });
    s.word(id('a', 1), 'One');
    const request = s.request('one', { limit: 7 });
    await hybridSearch(s.deps, request);
    expect(s.fullText.requests).toEqual([request]);
    expect(s.asked).toEqual([]);
  });

  it('does not let the full-text search fail inside the fusion be hidden: its error reaches the caller', async () => {
    const s = setup();
    s.fullText.failNext = new Error('boom');
    await expect(hybridSearch(s.deps, s.request())).rejects.toThrow('boom');
  });
});

describe('the pages of a hybrid answer', () => {
  it('returns each of 120 candidates once through requests of 50, with the cursor each request gives the next, and carries the full-text and the meaning lists the same way each time', async () => {
    const s = setup({ candidates: 100 });
    for (let i = 0; i < 100; i += 1) s.word(id('a', i), `Word ${String(i)}`, 10_000 - i);
    s.state.chunks = Array.from({ length: 100 }, (_, i) => s.meaning(id('b', i), `Meaning ${String(i)}`, `m ${String(i)}`, 0.9 - i / 1000));
    const seen: string[] = [];
    let cursor: string | undefined;
    const sizes: number[] = [];
    for (let request = 0; request < 6; request += 1) {
      const page = await hybridSearch(s.deps, s.request('q', { limit: 50, ...(cursor === undefined ? {} : { cursor }) }));
      sizes.push(page.hits.length);
      seen.push(...page.hits.map((h) => h.pageId));
      if (page.nextCursor === undefined) break;
      cursor = page.nextCursor;
    }
    expect(sizes).toEqual([50, 50, 5]); // 100 pages by words and 5 by meaning
    expect(new Set(seen).size).toBe(105);
  });

  it('puts a hybrid cursor under its own key, which the full-text cursor decoder refuses and the hybrid decoder reads', async () => {
    const s = setup();
    for (let i = 0; i < 3; i += 1) s.word(id('a', i), `Word ${String(i)}`);
    const page = await hybridSearch(s.deps, s.request('q', { limit: 2 }));
    expect(page.nextCursor).toBeDefined();
    expect(() => decodeSearchCursor(page.nextCursor as string)).toThrow(InvalidSearchCursor);
    expect(decodeHybridCursor(page.nextCursor as string)?.id).toBe(page.hits[1]?.pageId);
  });

  it('refuses to go on from a hybrid cursor without the semantic part, and says so, rather than answer from another order', async () => {
    const s = setup();
    for (let i = 0; i < 4; i += 1) s.word(id('a', i), `Word ${String(i)}`);
    const first = await hybridSearch(s.deps, s.request('q', { limit: 2 }));
    s.embedder.setStatus('loading');
    await expect(hybridSearch(s.deps, s.request('q', { limit: 2, cursor: first.nextCursor as string }))).rejects.toBeInstanceOf(HybridContinuationUnavailable);
    s.embedder.setStatus('ready');
    const second = await hybridSearch(s.deps, s.request('q', { limit: 2, cursor: first.nextCursor as string }));
    expect(second.hits.map((h) => h.pageId)).toEqual([id('a', 2), id('a', 3)]);
  });

  it('continues a cursor of the full-text search in the full-text search, even when the semantic part would answer now', async () => {
    const s = setup();
    for (let i = 0; i < 4; i += 1) s.word(id('a', i), `Word ${String(i)}`);
    const cursor = encodeSearchCursor({ rank: 0.5, editedAt: 1000, id: id('a', 1) });
    const page = await hybridSearch(s.deps, s.request('q', { limit: 2, cursor }));
    expect(page.semantic).toBe(false);
    expect(s.fullText.requests.at(-1)).toMatchObject({ cursor, limit: 2 });
    expect(s.asked).toEqual([]);
    expect(s.logs).toEqual([]);
  });

  it('refuses a cursor that is neither kind, as invalid', async () => {
    const s = setup();
    await expect(hybridSearch(s.deps, s.request('q', { cursor: 'bm90LWEtY3Vyc29y' }))).rejects.toBeInstanceOf(InvalidSearchCursor);
    await expect(hybridSearch(s.deps, s.request('q', { cursor: '!!!' }))).rejects.toBeInstanceOf(InvalidSearchCursor);
  });
});
