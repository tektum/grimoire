import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, createEmbeddingStore, createOpsDatabase, createSearchRepo } from '@tektum/grimoire-adapter-db-kysely';
import type { KyselyDatabase, OperatorDatabase } from '@tektum/grimoire-adapter-db-kysely';
import type { Embedder, EmbedResult } from '@tektum/grimoire-core/ports/embedder';
import type { EmbeddingStore } from '@tektum/grimoire-core/ports/embedding-store';
import { hybridSearch, type SemanticSearch } from '@tektum/grimoire-core/search/hybrid-search';
import { modelKey } from '@tektum/grimoire-core/semantic/model-key';
import { insertCollection, insertPage, insertUser, opsUrl, raw } from '@tektum/grimoire-test-support/database';
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
// GRIMOIRE_HYBRID_ASSERT=0 records the numbers and asserts nothing: the CI job runs the statement on the database as staging has it (1 GiB, about 180 MB of shared buffers, 2 vCPU) beside the one that must meet the limits.
const ASSERT = process.env['GRIMOIRE_HYBRID_ASSERT'] !== '0';
const SHAPE = process.env['GRIMOIRE_HYBRID_SHAPE'] ?? 'default';
const ROUNDS = 3; // each limit is judged on the median of this many p95 values (all of them are recorded)
const check = (value: number, limit: number): void => {
  if (ASSERT) expect(value).toBeLessThanOrEqual(limit);
};
const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] as number;
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
let ops: OperatorDatabase;
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
  ops = createOpsDatabase(opsUrl(DB));
  store = createEmbeddingStore(db, ops);
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
  record('data', { shape: SHAPE, asserted: ASSERT, pages: PAGES, chunks: counts.chunks, dims: DIMS, collections: COLLECTIONS, loadSeconds: Math.round((Date.now() - started) / 1000) });
}, 3_600_000);

afterAll(async () => {
  await db.close();
  await ops.close();
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
    const rounds: number[] = [];
    for (let i = 0; i < ROUNDS; i += 1) rounds.push(Math.round(p95(await statement(collections))));
    record('semanticAllCollectionsP95Ms', { rounds, median: median(rounds) });
    check(median(rounds), ALL_P95_MS);
  });

  it('has p95 within 100 ms for a user who sees 1% of the collections', { timeout: 600_000 }, async () => {
    const rounds: number[] = [];
    for (let i = 0; i < ROUNDS; i += 1) rounds.push(Math.round(p95(await statement([collections[0] as string]))));
    record('semanticOnePercentP95Ms', { rounds, median: median(rounds) });
    check(median(rounds), ONE_PERCENT_P95_MS);
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
    const rounds: { p95: number; max: number }[] = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      const times: number[] = [];
      for (let i = 0; i < QUERIES; i += 1) {
        const t = performance.now();
        const page = await hybridSearch({ fullText, semantic, log }, { tenantId: TENANT, collectionIds: collections, query: `${WORDS[i]} ${WORDS[i + 50]}`, limit: 20 });
        times.push(performance.now() - t);
        expect(page.semantic).toBe(true);
      }
      rounds.push({ p95: Math.round(p95(times)), max: Math.round(Math.max(...times)) });
    }
    record('hybridRequest', { rounds, medianOfMaxMs: median(rounds.map((r) => r.max)), medianP95Ms: median(rounds.map((r) => r.p95)) });
    check(median(rounds.map((r) => r.max)), REQUEST_MS);
  });

  // Evidence for the decision between tuning the table and an approximate index, recorded after the assertions (it changes the table): the plan is a parallel scan of `page_chunks` with one worker
  // (the table's own pages are few, because each 768-dimension vector sits out of line in the TOAST table) and the buffers say how much of the time is reading. Never asserted.
  it('records what two table settings do to the statement: more workers for the scan, and the vector stored in the row', { timeout: 1_800_000 }, async () => {
    // One round to warm the cache, then the 30 queries; and the workers the scan really got, read from the plan of one query.
    const measure = async (): Promise<{ p95Ms: number; workersLaunched: string; scan: string }> => {
      await statement(collections);
      const p95Ms = Math.round(p95(await statement(collections)));
      const vectorText = `[${[...(queryVectors[0] as Float32Array)].join(',')}]`;
      const plan = (await run(`explain (analyze, costs off) select c.page_id from page_chunks c where c.model = '${modelKey(model)}' order by c.embedding <=> '${vectorText}'::vector limit 300`)) as {
        'QUERY PLAN': string;
      }[];
      const lines = plan.map((r) => r['QUERY PLAN']);
      return {
        p95Ms,
        workersLaunched: lines.find((l) => l.includes('Workers Launched'))?.trim() ?? 'none',
        scan:
          lines
            .find((l) => l.includes('Scan on page_chunks'))
            ?.trim()
            .slice(0, 80) ?? '',
      };
    };
    record('experimentBaseline', await measure());
    await run('alter table page_chunks set (parallel_workers = 4)');
    record('experimentParallelWorkers4', await measure());
    await run('alter table page_chunks reset (parallel_workers)');
    // The vector stored in the row: the new setting only applies to a value written after it, and an update that writes the same value keeps its out-of-line copy, so the value is made again (a text round trip).
    await run('alter table page_chunks alter column embedding set storage main');
    await run('update page_chunks set embedding = (embedding::text)::vector');
    await run('vacuum (analyze) page_chunks');
    record('experimentStorageMain', await measure());
    await run('alter table page_chunks set (parallel_workers = 4)');
    record('experimentStorageMainAndWorkers4', await measure());
    const sizes = await run(`select pg_size_pretty(pg_relation_size('page_chunks')) as heap, pg_size_pretty(pg_total_relation_size('page_chunks') - pg_relation_size('page_chunks')) as rest`);
    record('tableSizesAfterStorageMain', sizes);
  });

  // The approximate index, for the decision, on this data and this database: build time and size, the time of the statement, and how much of the exact answer it returns (recall of the 300 nearest
  // chunks). The vectors here are uniformly random, which is the worst case for a graph index (real embeddings cluster), so the recall is a floor. The filter on collections is the point of the
  // 1% line: an index scan finds its nearest first and the permission filter comes after (iterative scan keeps going until it has enough). Never asserted.
  it('records the approximate index: build, size, time and recall against the exact scan, for all collections and for 1%', { timeout: 2_400_000 }, async () => {
    const key = modelKey(model);
    // One statement for each call (the connection speaks the extended protocol): the settings are the database's own, set before, and the exact scan is forced by an expression the index cannot serve.
    const query = (v: Float32Array, ids: readonly string[], hnsw: boolean): string =>
      `select c.page_id::text || ':' || c.chunk_index as k from page_chunks c join pages p on p.id = c.page_id
        where c.model = '${key}' and p.deleted_at is null and p.collection_id = any('{${ids.join(',')}}'::uuid[]) order by ${hnsw ? '' : '0 + '}(c.embedding <=> '[${[...v].join(',')}]'::vector) limit 300`;
    const keys = async (v: Float32Array, ids: readonly string[], hnsw: boolean): Promise<string[]> => ((await run(query(v, ids, hnsw))) as { k: string }[]).map((r) => r.k);
    const built = performance.now();
    await run(`alter database ${DB} set maintenance_work_mem = '512MB'`);
    await run(`alter database ${DB} set hnsw.iterative_scan = 'relaxed_order'`);
    await run(`alter database ${DB} set hnsw.ef_search = 400`);
    await run(`create index page_chunks_hnsw on page_chunks using hnsw (embedding vector_cosine_ops) where model = '${key}'`);
    const buildSeconds = Math.round((performance.now() - built) / 1000);
    await run('analyze page_chunks');
    const size = await run(`select pg_size_pretty(pg_relation_size('page_chunks_hnsw')) as size`);
    const lines: Record<string, unknown> = { buildSeconds, size };
    for (const [label, ids] of [
      ['all', collections],
      ['onePercent', [collections[0] as string]],
    ] as const) {
      const times: number[] = [];
      const recalls: number[] = [];
      const counts: number[] = [];
      for (const v of queryVectors.slice(0, 10)) {
        const exact = await keys(v, ids, false);
        const t = performance.now();
        const approximate = await keys(v, ids, true);
        times.push(performance.now() - t);
        const wanted = new Set(exact);
        recalls.push(exact.length === 0 ? 1 : approximate.filter((k) => wanted.has(k)).length / exact.length);
        counts.push(approximate.length);
      }
      lines[label] = { p95Ms: Math.round(p95(times)), meanRecall: Number((recalls.reduce((a, b) => a + b, 0) / recalls.length).toFixed(3)), minRows: Math.min(...counts), exactRows: 300 };
    }
    record('experimentHnsw', lines);
  });
});
