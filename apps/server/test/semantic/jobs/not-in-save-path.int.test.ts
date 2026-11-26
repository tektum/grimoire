import { randomUUID } from 'node:crypto';
import { createEmbeddingStore, createPageStore } from '@tektum/grimoire-adapter-db-kysely';
import type { EmbedResult } from '@tektum/grimoire-core/ports/embedder';
import { makeFakeConfig } from '@tektum/grimoire-core/testing/fake-config';
import { FakeEmbedder } from '@tektum/grimoire-core/testing/fake-embedder';
import { insertPage, raw } from '@tektum/grimoire-test-support/database';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { registerJobs } from '../../../src/jobs/index.js';
import { createJobRunner } from '../../../src/jobs/runner.js';
import { appUrl } from '../../server/support/harness.js';
import { fakeJobDeps } from '../../jobs/deps.js';
import { jobsDatabase, runtimeQueue, seedTenant } from '../../jobs/support.js';

// M7-T13: embedding is never in the path of a save. A page is saved with the write the collaboration host makes (`PageStore.store`) while a page is being embedded and the embedder is stuck
// on it: the save is fast, the embedder is not asked about it, and the source of the save path imports nothing of the embedding code (`save-path-imports.test.ts`). (The same under the real model, with the event loop
// measured, needs the built image: `quality.container.test.ts` measures that model's memory and recall, not the delay of the loop.)
const DB = 'grimoire_m7t13_not_in_save_path';
const SAVED = 'saved-marker-5521';
let db: Awaited<ReturnType<typeof jobsDatabase>>;
beforeAll(async () => { db = await jobsDatabase(DB); }, 120_000);
afterAll(async () => { await db?.drop(); });

/** An embedder that takes a call and answers it only when the test lets it. */
class BlockedEmbedder extends FakeEmbedder {
  readonly gate = Promise.withResolvers<void>();
  entered = 0;
  override async embedPassages(texts: readonly string[], o: { readonly signal?: AbortSignal } = {}): Promise<EmbedResult> {
    this.entered += 1;
    await this.gate.promise;
    return super.embedPassages(texts, o);
  }
}

describe('a save, while the embedder is busy', () => {
  it('returns in under 500 ms each time, does not ask the embedder about the page it saved, and the pages saved meanwhile are embedded once it is free', async () => {
    const tenant = await seedTenant(db.sql, 'T-save-path');
    const busy = randomUUID();
    await insertPage(db.sql, {
      id: busy, collection_id: tenant.collectionId, created_by: tenant.userId, tenant_id: tenant.tenantId, title: 'busy', text_content: 'busy page words',
      markdown_hash: raw(`decode(repeat('0e', 32), 'hex')`), last_edited_at: raw(`now() - interval '5 minutes'`),
    });
    const others = Array.from({ length: 5 }, () => randomUUID());
    for (const id of others) await insertPage(db.sql, { id, collection_id: tenant.collectionId, created_by: tenant.userId, tenant_id: tenant.tenantId, title: 'other', markdown: null });

    const embedder = new BlockedEmbedder({ maxTokens: 512, dims: 8 });
    const config = makeFakeConfig({ database: { url: appUrl(DB) }, semantic: { sweepSeconds: 1, debounceSeconds: 1 } });
    const { deps } = fakeJobDeps({ config, embedder, embeddings: createEmbeddingStore(db.app, db.ops), tenants: { ids: () => Promise.resolve([tenant.tenantId]) } });
    const runner = createJobRunner({ config, log: deps.log, make: () => runtimeQueue(DB), jobs: (queue) => registerJobs({ ...deps, queue }) });
    await runner.start();
    try {
      await vi.waitFor(() => { expect(embedder.entered).toBe(1); }, { timeout: 60_000, interval: 200 }); // the job of the busy page is in the embedder, which does not answer
      const saves = createPageStore(db.app, db.ops, { now: () => Date.now() });
      for (const id of others) {
        const began = performance.now();
        const outcome = await saves.store(tenant.tenantId, id, { kind: 'converted', state: new Uint8Array([1, 2, 3]), markdown: `M ${SAVED}`, text: `${SAVED} ${id}`, epoch: 0, editedAt: Date.now() });
        expect(performance.now() - began).toBeLessThan(500);
        expect(outcome).toEqual({ written: true });
      }
      expect(embedder.calls).toEqual([]); // nothing was embedded, and nothing was asked for the saved pages
      expect(embedder.entered).toBe(1);
      embedder.gate.resolve();
      await vi.waitFor(async () => {
        const [row] = (await db.sql(`select count(*) filter (where status = 'ready')::int as ready from page_embedding_state`)) as { ready: number }[];
        expect(row?.ready).toBe(6); // the busy page, and the five saved ones, found by the sweep after the debounce
      }, { timeout: 90_000, interval: 500 });
      // Evidence first, so that a failure of either check below says what happened: each page's state with its chunk rows and text length, and what the embedder was given.
      const states = await db.sql(`select left(s.page_id::text, 8) as page, s.status, s.chunk_count, s.error, s.attempts, (select count(*)::int from page_chunks c where c.page_id = s.page_id) as chunks,
                                          (select length(p.text_content) from pages p where p.id = s.page_id) as text_len, (select left(p.text_content, 40) from pages p where p.id = s.page_id) as text from page_embedding_state s order by s.page_id`);
      const asked = embedder.calls.flatMap((c) => c.texts);
      const diagnosis = JSON.stringify({ states, asked: asked.map((t) => t.slice(0, 80)), busy: busy.slice(0, 8) });
      const [chunks] = (await db.sql(`select count(distinct page_id)::int as pages from page_chunks where page_id in (${others.map((id) => `'${id}'`).join(',')})`)) as { pages: number }[];
      expect(chunks?.pages, diagnosis).toBe(others.length); // each saved page has its chunk rows
      expect(asked.filter((t) => t.includes(SAVED)), diagnosis).toHaveLength(others.length); // and the text asked for is the saved body, one text per saved page
    } finally {
      embedder.gate.resolve();
      await runner.hook.run();
    }
  }, 150_000);
});
