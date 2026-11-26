import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createEmbeddingStore, createSearchRepo } from '@tektum/grimoire-adapter-db-kysely';
import { createOnnxEmbedder } from '@tektum/grimoire-adapter-embedder-onnx';
import type { SemanticConfig } from '@tektum/grimoire-core/ports/config';
import { hybridSearch } from '@tektum/grimoire-core/search/hybrid-search';
import { FakeLogger } from '@tektum/grimoire-core/testing/fake-logger';
import { insertPage, raw } from '@tektum/grimoire-test-support/database';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createEventLog } from '../../src/events.js';
import { createEmbedPage } from '../../src/jobs/embed-page.js';
import { createRateLimiter } from '../../src/jobs/rate-limit.js';
import { jobsDatabase, seedTenant } from '../jobs/support.js';
import { loadCorpus } from './quality.js';

// M7-T07, the one figure `docs/search.md` says it lacks: the fused list (the words and the meaning of a search, fused by rank) against the full-text list alone, on the queries of the quality
// corpus, with the real model, the real embedding job and the real PostgreSQL store in one run. Each passage of the corpus is a page; every query is asked of the full-text search and of the hybrid
// search, five pages each, and the share of queries with a relevant page among them is the recall at 5 of each. The fused list must reach at least the recall of the full-text list, and a query
// for a rare identifier must still find its page first. The figures are printed as `fusedRecall`.
// Run it with the real files (`node scripts/fetch-models.mjs`, or GRIMOIRE_MODEL_DIR), a built tree (`bun run build`) and PostgreSQL (`make db-up`).
const modelDir = process.env['GRIMOIRE_MODEL_DIR'] ?? '/app/models';
const DB = 'grimoire_m7t07_fused_recall';
let db: Awaited<ReturnType<typeof jobsDatabase>>;
beforeAll(async () => { db = await jobsDatabase(DB); }, 120_000);
afterAll(async () => { await db?.drop(); });

describe('the fused list against the full-text list, with the real model', () => {
  it('reaches at least the recall at 5 of the full-text list on the corpus, and finds a rare identifier first', { timeout: 600_000 }, async () => {
    const corpus = loadCorpus();
    const tenant = await seedTenant(db.sql, 'T-fused');
    const passageOf = new Map<string, string>(); // page id -> passage id
    for (const passage of corpus.passages) {
      const id = randomUUID();
      passageOf.set(id, passage.id);
      await insertPage(db.sql, {
        id, collection_id: tenant.collectionId, created_by: tenant.userId, tenant_id: tenant.tenantId, title: passage.id, text_content: passage.text,
        markdown_hash: raw(`decode(repeat('0c', 32), 'hex')`), last_edited_at: raw(`now() - interval '5 minutes'`),
      });
    }

    const config: SemanticConfig = { enabled: true, model: 'multilingual-e5-base', modelDir, threads: 2, debounceSeconds: 30, sweepSeconds: 15, maxChunksPerMinute: 600, queryTimeoutMs: 5000, minSimilarity: 0, candidates: 100 };
    const embedder = createOnnxEmbedder(config, { lockFile: path.join(modelDir, 'models.lock.json') });
    try {
      await vi.waitFor(() => { expect(embedder.status(), 'the model did not load').toBe('ready'); }, { timeout: 120_000, interval: 50 });
      const store = createEmbeddingStore(db.app, db.ops);
      const embedPage = createEmbedPage({
        embedder, store, log: createEventLog(new FakeLogger()), clock: { now: () => Date.now() },
        limiter: createRateLimiter({ perMinute: 100_000, now: () => Date.now(), sleep: () => Promise.resolve() }), // the cap has tests of its own
      });
      for (const pageId of passageOf.keys()) await embedPage({ tenantId: tenant.tenantId, pageId }, { jobId: 'fused-recall', attempt: 1, retryLimit: 0, signal: new AbortController().signal });
      const ready = (await db.sql(`select count(*)::int as n from page_embedding_state where status = 'ready'`)) as { n: number }[];
      expect(ready[0]?.n, 'every passage is embedded').toBe(corpus.passages.length);

      const fullText = createSearchRepo(db.app, { statementTimeoutMs: 5000 });
      const semantic = { embedder, store, settings: { enabled: true, queryTimeoutMs: config.queryTimeoutMs, minSimilarity: config.minSimilarity, candidates: config.candidates } };
      const byKind: Record<string, { queries: number; fullText: number; fused: number }> = {};
      let fullTextHits = 0;
      let fusedHits = 0;
      const identifierFirst: { q: string; first: string | undefined; wanted: readonly string[] }[] = [];
      const notSemantic: string[] = [];
      for (const query of corpus.queries) {
        const request = { tenantId: tenant.tenantId, collectionIds: [tenant.collectionId], query: query.q, limit: 5 };
        const words = (await fullText.search(request)).hits.map((h) => passageOf.get(h.pageId));
        const fused = await hybridSearch({ fullText, semantic, log: { debug: () => undefined } }, request);
        if (!fused.semantic) notSemantic.push(query.q);
        const meaning = fused.hits.map((h) => passageOf.get(h.pageId));
        const wordHit = words.some((id) => id !== undefined && query.relevant.includes(id));
        const fusedHit = meaning.some((id) => id !== undefined && query.relevant.includes(id));
        const kind = (byKind[query.kind] ??= { queries: 0, fullText: 0, fused: 0 });
        kind.queries += 1;
        if (wordHit) { kind.fullText += 1; fullTextHits += 1; }
        if (fusedHit) { kind.fused += 1; fusedHits += 1; }
        if (query.kind === 'identifier') identifierFirst.push({ q: query.q, first: meaning[0], wanted: query.relevant });
      }
      const total = corpus.queries.length;
      const measured = { queries: total, fullTextRecallAt5: Number((fullTextHits / total).toFixed(3)), fusedRecallAt5: Number((fusedHits / total).toFixed(3)), byKind };
      console.log(JSON.stringify({ fusedRecall: measured, identifierFirst }));
      const why = JSON.stringify({ measured, identifierFirst, notSemantic });

      expect(notSemantic, why).toEqual([]); // the model was ready for every search: the lists are fused, not full text under another name
      expect(fusedHits, why).toBeGreaterThanOrEqual(fullTextHits);
      expect(identifierFirst.length, why).toBeGreaterThan(0);
      for (const row of identifierFirst) expect(row.wanted, `${row.q}: ${why}`).toContain(row.first);
    } finally {
      await embedder.close();
    }
  });
});
