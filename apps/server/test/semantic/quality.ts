import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Embedder } from '@tektum/grimoire-core/ports/embedder';

export interface Passage {
  readonly id: string;
  readonly text: string;
}
export interface Query {
  readonly q: string;
  readonly kind: string;
  /** The passages that answer it: a hit on any of them counts. */
  readonly relevant: readonly string[];
}
export interface Corpus {
  readonly passages: readonly Passage[];
  readonly queries: readonly Query[];
  /** Searches that match nothing in the corpus: what their best similarity is tells where a minimum similarity may be set. */
  readonly nonsense: readonly string[];
}

const dir = path.resolve(import.meta.dirname, 'corpus');
export const loadCorpus = (): Corpus => ({
  passages: JSON.parse(readFileSync(path.join(dir, 'passages.json'), 'utf8')) as Passage[],
  queries: JSON.parse(readFileSync(path.join(dir, 'queries.json'), 'utf8')) as Query[],
  nonsense: JSON.parse(readFileSync(path.join(dir, 'nonsense.json'), 'utf8')) as string[],
});

export interface Quality {
  /** Of the queries, the share with a relevant passage among the five most similar. */
  readonly recallAt5: number;
  readonly byKind: Readonly<Record<string, { readonly queries: number; readonly hits: number }>>;
  readonly misses: readonly { readonly q: string; readonly kind: string; readonly top5: readonly string[] }[];
  /** For each query, the similarity of its best relevant passage, and of the best passage of any kind for each nonsense search, sorted. */
  readonly relevantSimilarity: readonly number[];
  readonly nonsenseSimilarity: readonly number[];
}

const dot = (a: Float32Array, b: Float32Array): number => a.reduce((sum, x, i) => sum + x * (b[i] as number), 0);
const sorted = (values: number[]): number[] => values.sort((x, y) => x - y).map((v) => Number(v.toFixed(4)));

/** Embeds the passages as passages and every query as a query, and ranks the passages of each by cosine similarity (the vectors are of length 1, so the dot product). */
export async function evaluate(embedder: Embedder, corpus: Corpus): Promise<Quality> {
  const passages = await embedder.embedPassages(corpus.passages.map((p) => p.text));
  if (!passages.ok) throw new Error(`the passages were not embedded: ${passages.reason}`);
  const rank = async (text: string): Promise<{ id: string; similarity: number }[]> => {
    const q = await embedder.embedQuery(text);
    if (!q.ok) throw new Error(`a query was not embedded: ${q.reason}`);
    return corpus.passages.map((p, i) => ({ id: p.id, similarity: dot(q.vectors[0] as Float32Array, passages.vectors[i] as Float32Array) })).sort((a, b) => b.similarity - a.similarity);
  };
  const byKind: Record<string, { queries: number; hits: number }> = {};
  const misses: { q: string; kind: string; top5: string[] }[] = [];
  const relevantSimilarity: number[] = [];
  let hits = 0;
  for (const query of corpus.queries) {
    const ranked = await rank(query.q);
    const top5 = ranked.slice(0, 5).map((r) => r.id);
    const hit = top5.some((id) => query.relevant.includes(id));
    const kind = (byKind[query.kind] ??= { queries: 0, hits: 0 });
    kind.queries += 1;
    if (hit) {
      kind.hits += 1;
      hits += 1;
    } else misses.push({ q: query.q, kind: query.kind, top5 });
    relevantSimilarity.push(Math.max(...ranked.filter((r) => query.relevant.includes(r.id)).map((r) => r.similarity)));
  }
  const nonsenseSimilarity: number[] = [];
  for (const text of corpus.nonsense) nonsenseSimilarity.push((await rank(text))[0]?.similarity ?? 0);
  return { recallAt5: hits / corpus.queries.length, byKind, misses, relevantSimilarity: sorted(relevantSimilarity), nonsenseSimilarity: sorted(nonsenseSimilarity) };
}
