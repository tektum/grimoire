import { randomUUID } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createEmbeddingStore, createPageStore } from '@tektum/grimoire-adapter-db-kysely';
import { createOnnxEmbedder } from '@tektum/grimoire-adapter-embedder-onnx';
import type { SemanticConfig } from '@tektum/grimoire-core/ports/config';
import { FakeLogger } from '@tektum/grimoire-core/testing/fake-logger';
import { insertPage, raw } from '@tektum/grimoire-test-support/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEventLog } from '../../src/events.js';
import { createEmbedPage } from '../../src/jobs/embed-page.js';
import { createRateLimiter } from '../../src/jobs/rate-limit.js';
import { jobsDatabase, seedTenant } from '../jobs/support.js';

// M7-T13 (not in the save path, part b): the real model embeds a page of 20,000 words, through the real `embed-page` job and the real PostgreSQL store, while saves go through the real
// page store, and the event loop of this process is measured the whole time. The model has its own thread; what the main thread does for the job (cutting the text into chunks, counting
// tokens, the database) and for the saves must not hold it for long. The limits are those of the task: p99 of the loop delay at most 50 ms, its maximum at most 200 ms, each save under 500 ms.
// Run it with the real files (`node scripts/fetch-models.mjs`, the image's /app/models, or GRIMOIRE_MODEL_DIR), a built tree (`bun run build`) and PostgreSQL (`make db-up`).
const modelDir = process.env['GRIMOIRE_MODEL_DIR'] ?? '/app/models';
const DB = 'grimoire_m7t13_event_loop';
const WORDS = 20_000;
const SAVES = 20;
const P99_MS = 50;
const MAX_MS = 200;
const SAVE_MS = 500;
/** A resolution of 10 ms is the floor of every value the histogram reports (a timer that fires on time is recorded as about 10 ms). */
const RESOLUTION_MS = 10;

let db: Awaited<ReturnType<typeof jobsDatabase>>;
beforeAll(async () => { db = await jobsDatabase(DB); }, 120_000);
afterAll(async () => { await db?.drop(); });

const SYLLABLES = ['ka', 'lo', 'mi', 'ra', 'te', 'su', 'no', 'vi', 'pa', 'de', 'ru', 'an', 'el', 'or', 'is'];
/** A word of two to four syllables that the tokenizer splits into several pieces, so the page has more tokens than words: the same word for the same number. */
function word(n: number): string {
  let x = (n * 2_654_435_761) % 4_294_967_296;
  let w = '';
  for (let k = 0; k < 2 + (x % 3); k++) {
    x = (x * 1_103_515_245 + 12_345) % 2_147_483_648;
    w += SYLLABLES[x % SYLLABLES.length];
  }
  return `${w}${String(n % 7)}`;
}
/** `count` words in paragraphs of 100. */
const pageText = (count: number): string => Array.from({ length: count / 100 }, (_, p) => Array.from({ length: 100 }, (_, k) => word(p * 100 + k)).join(' ')).join('\n\n');

describe('the real model, embedding a page of 20,000 words', () => {
  it('leaves the event loop free while saves go on: p99 of its delay within 50 ms, its maximum within 200 ms, every save under 500 ms', { timeout: 600_000 }, async () => {
    const config: SemanticConfig = { enabled: true, model: 'multilingual-e5-base', modelDir, threads: 2, debounceSeconds: 30, sweepSeconds: 15, maxChunksPerMinute: 600, queryTimeoutMs: 1500, minSimilarity: 0, candidates: 100 };
    const embedder = createOnnxEmbedder(config, { lockFile: path.join(modelDir, 'models.lock.json') });
    try {
      const deadline = Date.now() + 120_000;
      while (embedder.status() !== 'ready') {
        if (Date.now() > deadline) throw new Error(`the model did not load: ${embedder.status()}`);
        await sleep(50);
      }
      const tenant = await seedTenant(db.sql, 'T-event-loop');
      const pageId = randomUUID();
      const text = pageText(WORDS);
      await insertPage(db.sql, {
        id: pageId, collection_id: tenant.collectionId, created_by: tenant.userId, tenant_id: tenant.tenantId, title: 'Long', text_content: text,
        markdown_hash: raw(`decode(repeat('0b', 32), 'hex')`), last_edited_at: raw(`now() - interval '5 minutes'`),
      });
      const others = Array.from({ length: SAVES }, () => randomUUID());
      for (const id of others) await insertPage(db.sql, { id, collection_id: tenant.collectionId, created_by: tenant.userId, tenant_id: tenant.tenantId, title: 'Saved', markdown: null });

      const embedPage = createEmbedPage({
        embedder, store: createEmbeddingStore(db.app, db.ops), log: createEventLog(new FakeLogger()), clock: { now: () => Date.now() },
        limiter: createRateLimiter({ perMinute: 100_000, now: () => Date.now(), sleep: () => Promise.resolve() }), // the cap is the subject of its own tests: here it must not be what slows the page down
      });
      const saves = createPageStore(db.app, db.ops, { now: () => Date.now() });

      const delay = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
      delay.enable();
      let embedding = true;
      const began = performance.now();
      const embedded = embedPage({ tenantId: tenant.tenantId, pageId }, { jobId: 'event-loop', attempt: 1, retryLimit: 0, signal: new AbortController().signal }).finally(() => { embedding = false; });
      const saved: number[] = [];
      let savedWhileEmbedding = 0;
      for (const id of others) {
        const from = performance.now();
        const outcome = await saves.store(tenant.tenantId, id, { kind: 'converted', state: new Uint8Array([1, 2, 3]), markdown: `# Saved\n\n${pageText(400)}`, text: pageText(400), epoch: 0, editedAt: Date.now() });
        saved.push(performance.now() - from);
        if (embedding) savedWhileEmbedding += 1;
        expect(outcome).toEqual({ written: true });
        await sleep(200); // a save about every 200 ms, as a person types
      }
      await embedded;
      const embedMs = performance.now() - began;
      delay.disable();

      const [state] = (await db.sql(`select status, chunk_count from page_embedding_state where page_id = '${pageId}'`)) as { status: string; chunk_count: number }[];
      const measured = {
        words: WORDS, chunks: state?.chunk_count, embedMs: Math.round(embedMs), savedWhileEmbedding, saveMsMax: Math.round(Math.max(...saved)),
        loopDelayMs: { p50: delay.percentile(50) / 1e6, p99: delay.percentile(99) / 1e6, max: delay.max / 1e6 },
      };
      console.log(JSON.stringify({ eventLoop: measured }));
      const why = JSON.stringify(measured);

      expect(state?.status, why).toBe('ready');
      expect(state?.chunk_count ?? 0, why).toBeGreaterThan(100); // a page of this size is many chunks: it was embedded, not skipped
      expect(savedWhileEmbedding, why).toBeGreaterThanOrEqual(SAVES - 3); // the saves overlapped the embedding, which is what is measured
      expect(Math.max(...saved), why).toBeLessThan(SAVE_MS);
      expect(delay.percentile(99) / 1e6, why).toBeLessThanOrEqual(P99_MS);
      expect(delay.max / 1e6, why).toBeLessThanOrEqual(MAX_MS);
    } finally {
      await embedder.close();
    }
  });
});
