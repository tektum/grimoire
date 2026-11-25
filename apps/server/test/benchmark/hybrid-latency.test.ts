import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, createEmbeddingStore, createSearchRepo } from '@tektum/grimoire-adapter-db-kysely';
import type { KyselyDatabase } from '@tektum/grimoire-adapter-db-kysely';
import type { Embedder, EmbedResult } from '@tektum/grimoire-core/ports/embedder';
import type { EmbeddingStore } from '@tektum/grimoire-core/ports/embedding-store';
import { hybridSearch, type SemanticSearch } from '@tektum/grimoire-core/search/hybrid-search';
import { modelKey } from '@tektum/grimoire-core/semantic/model-key';
import { insertCollection, insertPage, insertUser, raw } from '@tektum/grimoire-test-support/database';
import { appUrl, createTestDatabase, dropTestDatabase, requireBuild, sqlAdmin } from '../server/support/harness.js';

// M7-T14 (R9.10), in the benchmark project (not the integration one: loading the vectors takes minutes, which every pull request would pay): the `Search latency` job of CI runs it when a change touches
// the search, and the nightly benchmark job runs it with the other benchmarks. The semantic statement over 140,000 chunk vectors of 768 dimensions (10,000 pages of 14 chunks, from a seeded generator) with no index: brute force, as shipped. The measured
// sizes and timings are what `docs/proof/m7-hybrid-search.md` records; GRIMOIRE_HYBRID_OUT names a file to write them to as JSON. A result above the limits fails here, and the task reports it
// before an approximate index (HNSW) is chosen.
const DB = 'grimoire_m7t14_latency';
const TENANT = 'legacy';
const DIMS = 768;
const PAGES = Number(process.env['GRIMOIRE_HYBRID_PAGES'] ?? 10_000);
const CHUNKS = 14;
const COLLECTIONS = 100; // a user who sees one of them sees 1%
const QUERIES = 30;
const ALL_P95_MS = 400;
const REQUEST_MS = 1000;
const ONE_PERCENT_P95_MS = 100;
const model = { name: 'seeded', version: 'v1', dims: DIMS, maxTokens: 504 };
const run = (sql: string) => sqlAdmin(DB, sql);

/** A small seeded generator (mulberry32): the same vectors and words in every run. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const vector = (random: () => number): Float32Array => {
  const v = new Float32Array(DIMS);
  let norm = 0;
  for (let i = 0; i < DIMS; i += 1) {
    v[i] = random() * 2 - 1;
    norm += (v[i] as number) ** 2;
  }
  norm = Math.sqrt(norm);
  return v.map((x) => x / norm);
};
const WORDS = Array.from({ length: 400 }, (_, i) => `w${i.toString(36)}`);
const sentence = (random: () => number, n: number): string => Array.from({ length: n }, () => WORDS[Math.floor(random() * WORDS.length)]).join(' ');

let db: KyselyDatabase;
let store: EmbeddingStore;
const collections: string[] = [];
const queryVectors: Float32Array[] = [];
const measured: Record<string, unknown> = {};
const record = (part: string, value: unknown): void => {
  measured[part] = value;
  if (process.env['GRIMOIRE_HYBRID_OUT'] !== undefined) {
    mkdirSync(path.dirname(process.env['GRIMOIRE_HYBRID_OUT']), { recursive: true });
    writeFileSync(process.env['GRIMOIRE_HYBRID_OUT'], JSON.stringify(measured, null, 2));
  }
  console.log(JSON.stringify({ [part]: value }));
};
const p95 = (ms: number[]): number => [...ms].sort((a, b) => a - b)[Math.ceil(ms.length * 0.95) - 1] as number;

beforeAll(async () => {
  requireBuild();
  await createTestDatabase(DB, true);
  db = createDatabase(appUrl(DB));
  store = createEmbeddingStore(db);
  const user = await insertUser(run, {});
  for (let c = 0; c < COLLECTIONS; c += 1) collections.push(await insertCollection(run, { created_by: user, default_permission: 'read' }));
  const random = seeded(7);
  const hash = (n: number): Uint8Array => new Uint8Array(32).fill(n);
  const hex = '01'.repeat(32);
  const key = modelKey(model);
  const started = Date.now();
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= PAGES) return;
      const text = sentence(random, 14 * 8);
      const id = await insertPage(run, { collection_id: collections[index % COLLECTIONS] as string, created_by: user, title: `Page ${String(index)}`, text_content: text, markdown_hash: raw(`decode('${hex}', 'hex')`) });
      const chunks = Array.from({ length: CHUNKS }, (_, i) => ({ chunkIndex: i, contentHash: hash(2 + (i % 200)), charStart: i * 8, charEnd: i * 8 + 7, tokenCount: 8, embedding: vector(random) }));
      if ((await store.replacePage(TENANT, id, hash(1), key, chunks)) !== 'ok') throw new Error(`page ${String(index)} was not written`);
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  for (let q = 0; q < QUERIES; q += 1) queryVectors.push(vector(random));
  await run('analyze page_chunks');
  const counts = await store.counts(key);
  record('data', { pages: PAGES, chunks: counts.chunks, dims: DIMS, collections: COLLECTIONS, loadSeconds: Math.round((Date.now() - started) / 1000) });
}, 3_600_000);

afterAll(async () => {
  await db.close();
  await dropTestDatabase(DB);
});

const statement = async (collectionIds: readonly string[]): Promise<number[]> => {
  const times: number[] = [];
  for (const v of queryVectors) {
    const t = performance.now();
    await store.search(TENANT, v, { model: modelKey(model), collectionIds, limit: 100, minSimilarity: 0 });
    times.push(performance.now() - t);
  }
  return times;
};

describe('the semantic statement without an index', () => {
  // What the numbers below rest on, recorded (never asserted): the settings of the database and the plan of the statement with every collection visible, as the store sends it.
  it('records the database settings and the plan of the statement', { timeout: 600_000 }, async () => {
    const settings = await run(
      `select name, setting, unit from pg_settings where name in ('shared_buffers', 'work_mem', 'effective_cache_size', 'max_parallel_workers_per_gather', 'max_parallel_workers', 'max_worker_processes', 'jit') order by name`,
    );
    record('postgresSettings', settings);
    const vectorText = `[${[...(queryVectors[0] as Float32Array)].join(',')}]`;
    const ids = `{${collections.join(',')}}`;
    const plan = await run(
      `explain (analyze, buffers, costs off) with nearest as (select c.page_id, c.chunk_index, c.embedding <=> '${vectorText}'::vector as distance from page_chunks c join pages p on p.id = c.page_id
         where c.model = '${modelKey(model)}' and c.tenant_id = '${TENANT}' and p.tenant_id = '${TENANT}' and p.deleted_at is null and p.collection_id = any('${ids}'::uuid[]) and 1 - (c.embedding <=> '${vectorText}'::vector) >= 0
         order by distance, c.page_id, c.chunk_index limit 300) select count(*) from nearest`,
    );
    record(
      'plan',
      (plan as { 'QUERY PLAN': string }[]).map((r) => r['QUERY PLAN']),
    );
  });

  it('has p95 within 400 ms for a user who sees every collection', { timeout: 600_000 }, async () => {
    await statement(collections); // one round to warm the cache, not counted
    const all = p95(await statement(collections));
    record('semanticAllCollectionsP95Ms', Math.round(all));
    expect(all).toBeLessThanOrEqual(ALL_P95_MS);
  });

  it('has p95 within 100 ms for a user who sees 1% of the collections', { timeout: 600_000 }, async () => {
    const one = p95(await statement([collections[0] as string]));
    record('semanticOnePercentP95Ms', Math.round(one));
    expect(one).toBeLessThanOrEqual(ONE_PERCENT_P95_MS);
  });

  it('answers the whole hybrid request within 1,000 ms', { timeout: 600_000 }, async () => {
    const embedder: Embedder = {
      model,
      status: () => 'ready',
      countTokens: (t) => t.split(/\s+/).length,
      embedPassages: () => Promise.resolve<EmbedResult>({ ok: false, reason: 'unavailable' }),
      embedQuery: (text) => Promise.resolve<EmbedResult>({ ok: true, vectors: [queryVectors[text.length % QUERIES] as Float32Array] }),
      stats: () => ({ threads: 1, queued: 0, chunksPerMinute: 0 }),
      close: () => Promise.resolve(),
    };
    const log = { debug() {}, info() {}, warn() {}, error() {}, child: () => log } as never;
    const semantic: SemanticSearch = { embedder, store, settings: { enabled: true, queryTimeoutMs: 1500, minSimilarity: 0, candidates: 100 } };
    const fullText = createSearchRepo(db, { statementTimeoutMs: 5000 });
    const times: number[] = [];
    for (let i = 0; i < QUERIES; i += 1) {
      const t = performance.now();
      const page = await hybridSearch({ fullText, semantic, log }, { tenantId: TENANT, collectionIds: collections, query: `${WORDS[i]} ${WORDS[i + 50]}`, limit: 20 });
      times.push(performance.now() - t);
      expect(page.semantic).toBe(true);
    }
    const worst = Math.max(...times);
    record('hybridRequestP95Ms', Math.round(p95(times)));
    record('hybridRequestMaxMs', Math.round(worst));
    expect(worst).toBeLessThanOrEqual(REQUEST_MS);
  });
});
