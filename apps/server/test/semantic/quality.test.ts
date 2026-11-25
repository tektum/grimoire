import { FakeEmbedder } from '@tektum/grimoire-core/testing/fake-embedder';
import { describe, expect, it } from 'vitest';
import { evaluate, loadCorpus } from './quality.js';

// The corpus of the semantic search's quality check (M7-T12) and the arithmetic of the check. The models are in `quality.container.test.ts`.
describe('the quality corpus', () => {
  const corpus = loadCorpus();

  it('has at least 40 passages and 30 queries, every query answered by passages that exist, and no id twice', () => {
    expect(corpus.passages.length).toBeGreaterThanOrEqual(40);
    expect(corpus.queries.length).toBeGreaterThanOrEqual(30);
    const ids = corpus.passages.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const q of corpus.queries) {
      expect(q.relevant.length, q.q).toBeGreaterThan(0);
      for (const id of q.relevant) expect(ids, q.q).toContain(id);
    }
    expect(corpus.nonsense).toHaveLength(10);
  });

  it('covers synonyms, paraphrases, questions, exact identifiers, a Hebrew passage with an English query against it, and Hebrew queries', () => {
    const kinds = new Set(corpus.queries.map((q) => q.kind));
    for (const kind of ['synonym', 'paraphrase', 'question', 'identifier', 'english-to-hebrew', 'hebrew-query']) expect(kinds, kind).toContain(kind);
    const hebrew = /[\u0590-\u05ff]/;
    const hebrewPassages = new Set(corpus.passages.filter((p) => hebrew.test(p.text)).map((p) => p.id));
    expect(hebrewPassages.size).toBeGreaterThanOrEqual(1);
    for (const q of corpus.queries.filter((x) => x.kind === 'english-to-hebrew')) {
      expect(hebrew.test(q.q), q.q).toBe(false);
      // Only a Hebrew passage answers it: the English original of a Hebrew passage would make the query pass without the model crossing the language.
      expect(
        q.relevant.every((id) => hebrewPassages.has(id)),
        q.q,
      ).toBe(true);
    }
    for (const q of corpus.queries.filter((x) => x.kind === 'hebrew-query')) expect(hebrew.test(q.q), q.q).toBe(true);
  });
});

describe('evaluate', () => {
  const small = {
    passages: [
      { id: 'A', text: 'red apple fruit' },
      { id: 'B', text: 'blue ocean water' },
      { id: 'C', text: 'green forest trees' },
    ],
    nonsense: ['zzz'],
  };

  it('counts a query as found when a relevant passage is among the five most similar, tells the misses by kind, and sorts the similarities', async () => {
    const corpus = {
      ...small,
      queries: [
        { q: 'red apple', kind: 'synonym', relevant: ['A'] },
        { q: 'ocean water', kind: 'synonym', relevant: ['B', 'C'] },
        { q: 'green forest', kind: 'question', relevant: ['A'] },
      ],
    };
    const q = await evaluate(new FakeEmbedder({ dims: 64, maxTokens: 64 }), corpus);
    // With three passages every one is in the top five: all found, whatever the vectors are.
    expect(q.recallAt5).toBe(1);
    expect(q.byKind).toEqual({ synonym: { queries: 2, hits: 2 }, question: { queries: 1, hits: 1 } });
    expect(q.misses).toEqual([]);
    expect([...q.relevantSimilarity]).toEqual([...q.relevantSimilarity].sort((a, b) => a - b));
    expect(q.nonsenseSimilarity).toHaveLength(1);
  });

  it('counts a miss when the relevant passage is ranked sixth or lower, and says what ranked instead', async () => {
    const passages = [...Array.from({ length: 7 }, (_, i) => ({ id: `P${String(i)}`, text: `shared words topic${String(i)}` })), { id: 'P7', text: 'qqq rrr sss' }];
    const queries = [
      { q: 'qqq rrr sss', kind: 'paraphrase', relevant: ['P7'] },
      { q: 'shared words topic0', kind: 'paraphrase', relevant: ['P7'] }, // the one passage that shares no word with it: eighth of eight
    ];
    const q = await evaluate(new FakeEmbedder({ dims: 256, maxTokens: 64 }), { passages, nonsense: [], queries });
    expect(q.byKind['paraphrase']).toEqual({ queries: 2, hits: 1 });
    expect(q.recallAt5).toBe(0.5);
    expect(q.misses).toHaveLength(1);
    expect(q.misses[0]?.q).toBe('shared words topic0');
    expect(q.misses[0]?.top5).toHaveLength(5);
    expect(q.misses[0]?.top5[0]).toBe('P0');
    expect(q.misses[0]?.top5).not.toContain('P7');
  });

  it('is an error, not a zero, when the model does not answer', async () => {
    const e = new FakeEmbedder({ dims: 8, maxTokens: 64 });
    e.setStatus('unavailable');
    await e.close();
    await expect(evaluate(e, { ...small, queries: [{ q: 'x', kind: 'k', relevant: ['A'] }] })).rejects.toThrow('the passages were not embedded');
  });
});
