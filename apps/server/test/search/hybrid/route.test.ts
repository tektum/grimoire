import { describe, expect, it } from 'vitest';
import type { ChunkHit, EmbeddingStore } from '@tektum/grimoire-core/ports/embedding-store';
import type { SemanticSearch } from '@tektum/grimoire-core/search/hybrid-search';
import { FakeEmbedder } from '@tektum/grimoire-core/testing/fake-embedder';
import { build, PAGE } from '../support.js';

// `GET /v1/search` with the semantic part (M7-T14), on fake stores: the fusion and the fallbacks as the route answers them.
const MEANING = (n: number) => `00000000-0000-4000-8000-0000000009${String(n).padStart(2, '0')}`;

function semantic(over: { enabled?: boolean } = {}) {
  const embedder = new FakeEmbedder({ name: 'multilingual-e5-base', version: 'int8@abcd1234', dims: 8 });
  const state: { chunks: ChunkHit[]; fail: boolean; asked: number } = { chunks: [], fail: false, asked: 0 };
  const store = {
    search: (_t, _v, o) => {
      state.asked += 1;
      return state.fail ? Promise.reject(new Error('the statement failed')) : Promise.resolve(state.chunks.slice(0, o.limit));
    },
  } as EmbeddingStore;
  const config: SemanticSearch = { embedder, store, settings: { enabled: over.enabled ?? true, queryTimeoutMs: 1500, minSimilarity: 0, candidates: 100 } };
  const chunk = (n: number, collectionId: string, text: string, similarity = 0.8): ChunkHit => ({
    pageId: MEANING(n),
    chunkIndex: 0,
    charStart: 0,
    charEnd: text.length,
    similarity,
    text,
    editedAt: 1_700_000_000_000_000,
    title: `Meaning ${String(n)}`,
    urlId: `m${String(n)}`,
    collectionId,
  });
  return { config, embedder, state, chunk };
}

interface Item {
  pageId: string;
  title: string;
  snippet: { text: string; ranges: number[][] };
  matchedPassage?: { text: string };
  rank: number;
  updatedAt: string;
}
const read = async (res: Response) => (await res.json()) as { items: Item[]; semantic: boolean; nextCursor: string | null };

describe('GET /v1/search with the semantic search', () => {
  it('returns a page found by words and one found only by meaning, with semantic: true, the passage of the second and its first 160 characters as the snippet', async () => {
    const sem = semantic();
    const t = build('read', sem.config);
    t.hit(1, t.open);
    const passage = `${'The quarterly plan covers hiring and the budget for next year. '.repeat(30)}`; // far over 300 characters
    sem.state.chunks = [sem.chunk(1, t.open, passage)];
    const res = await t.call('member', '?q=plan');
    expect(res.status).toBe(200);
    const body = await read(res);
    expect(body.semantic).toBe(true);
    expect(body.items.map((i) => i.pageId)).toEqual([MEANING(1), PAGE(1)]);
    const [meaning, words] = body.items as [Item, Item];
    expect(meaning.matchedPassage?.text.length).toBeLessThanOrEqual(300);
    expect(meaning.matchedPassage?.text.startsWith('The quarterly plan covers hiring')).toBe(true);
    expect(meaning.snippet).toEqual({ text: meaning.matchedPassage?.text.slice(0, 160), ranges: [] });
    expect(meaning.title).toBe('Meaning 1');
    expect(words.matchedPassage).toBeUndefined();
    expect(words.snippet).toEqual({ text: 'a match here', ranges: [[2, 7]] }); // the highlighted snippet stays
  });

  it('answers the full-text list alone, with semantic: false and status 200, when the setting is off, the model is not ready, the query is late and the statement throws', async () => {
    for (const arrange of [
      (s: ReturnType<typeof semantic>) => s.embedder.setStatus('loading'),
      (s: ReturnType<typeof semantic>) => s.embedder.failNext('timeout'),
      (s: ReturnType<typeof semantic>) => void (s.state.fail = true),
    ]) {
      const sem = semantic();
      const t = build('read', sem.config);
      t.hit(1, t.open);
      sem.state.chunks = [sem.chunk(1, t.open, 'only by meaning')];
      arrange(sem);
      const res = await t.call('member', '?q=plan');
      expect(res.status).toBe(200);
      const body = await read(res);
      expect(body.semantic).toBe(false);
      expect(body.items.map((i) => i.pageId)).toEqual([PAGE(1)]);
      expect(body.items[0]?.matchedPassage).toBeUndefined();
    }
    const off = semantic({ enabled: false });
    const t = build('read', off.config);
    t.hit(1, t.open);
    expect((await read(await t.call('member', '?q=plan'))).semantic).toBe(false);
    expect(off.state.asked).toBe(0);
  });

  it('is the answer it was without the semantic part when there is none wired: semantic false and the old shape of an item', async () => {
    const t = build('read');
    t.hit(1, t.open);
    const body = await read(await t.call('member', '?q=plan'));
    expect(body.semantic).toBe(false);
    expect(Object.keys(body.items[0] as object).sort()).toEqual(['collectionId', 'pageId', 'rank', 'snippet', 'title', 'updatedAt', 'urlId']);
  });

  it('answers a search that matches nothing with at most five pages found by meaning, each with its passage', async () => {
    const sem = semantic();
    const t = build('read', sem.config);
    sem.state.chunks = Array.from({ length: 40 }, (_, i) => sem.chunk(i, t.open, `passage ${String(i)}`, 0.8 - i / 1000));
    const body = await read(await t.call('member', '?q=purple%20elephants'));
    expect(body.items).toHaveLength(5);
    expect(body.items.every((i) => i.matchedPassage !== undefined && i.snippet.ranges.length === 0)).toBe(true);
    expect(body.nextCursor).toBeNull();
  });

  it('continues a hybrid answer with its cursor, and says 503 unavailable, not a page of another order, when the semantic part is gone by then', async () => {
    const sem = semantic();
    const t = build('read', sem.config);
    for (let i = 1; i <= 6; i += 1) t.hit(i, t.open);
    const first = await read(await t.call('member', '?q=plan&limit=4'));
    expect(first.items).toHaveLength(4);
    expect(first.nextCursor).not.toBeNull();
    const second = await read(await t.call('member', `?q=plan&limit=4&cursor=${first.nextCursor as string}`));
    expect([...first.items, ...second.items].map((i) => i.pageId)).toEqual([1, 2, 3, 4, 5, 6].map(PAGE));
    sem.embedder.setStatus('unavailable');
    const gone = await t.call('member', `?q=plan&limit=4&cursor=${first.nextCursor as string}`);
    expect(gone.status).toBe(503);
    expect(((await gone.json()) as { error: { code: string } }).error.code).toBe('unavailable');
    expect(t.logger.entries.filter((e) => e.event === 'search.semantic_fallback').map((e) => e.fields['reason'])).toEqual(['continuation']);
  });
});
