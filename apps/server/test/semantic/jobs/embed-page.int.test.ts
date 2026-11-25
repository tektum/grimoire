import { randomUUID } from 'node:crypto';
import { createEmbeddingStore } from '@tektum/grimoire-adapter-db-kysely';
import { insertPage, raw } from '@tektum/grimoire-test-support/database';
import { makeFakeConfig } from '@tektum/grimoire-core/testing/fake-config';
import { FakeEmbedder } from '@tektum/grimoire-core/testing/fake-embedder';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { registerJobs } from '../../../src/jobs/index.js';
import { modelKey } from '@tektum/grimoire-core/semantic/model-key';
import { createJobRunner } from '../../../src/jobs/runner.js';
import { appUrl } from '../../server/support/harness.js';
import { fakeJobDeps } from '../../jobs/deps.js';
import { jobsDatabase, runtimeQueue, seedTenant } from '../../jobs/support.js';

// M7-T13: a page is embedded by the real job, on the real queue and the real store, with the runtime role.
const DB = 'grimoire_m7t13_embed_page';
let db: Awaited<ReturnType<typeof jobsDatabase>>;
beforeAll(async () => { db = await jobsDatabase(DB); }, 120_000);
afterAll(async () => { await db?.drop(); });

const words = (n: number, tag: string): string => Array.from({ length: n }, (_, i) => `${tag}${String(i)}`).join(' ');

describe('embed-page, through the runner', () => {
  it('embeds a page enqueued for it: the chunks and the state are in the tables, with the dimension of the embedder', async () => {
    const tenant = await seedTenant(db.sql, 'T-embed');
    const pageId = randomUUID();
    await insertPage(db.sql, {
      id: pageId, collection_id: tenant.collectionId, created_by: tenant.userId, tenant_id: tenant.tenantId, title: 'T',
      text_content: `${words(200, 'a')}\n\n${words(200, 'b')}\n\n${words(40, 'c')}`, markdown_hash: raw(`decode(repeat('0a', 32), 'hex')`), last_edited_at: raw(`now() - interval '5 minutes'`),
    });
    const config = makeFakeConfig({ database: { url: appUrl(DB) } });
    const embedder = new FakeEmbedder({ maxTokens: 512, dims: 8 });
    const { deps } = fakeJobDeps({ config, embedder, embeddings: createEmbeddingStore(db.app, db.ops) });
    const runner = createJobRunner({ config, log: deps.log, make: () => runtimeQueue(DB), jobs: registerJobs(deps) });
    await runner.start();
    const queue = await runtimeQueue(DB);
    try {
      expect(runner.state()).toBe('up');
      await queue.enqueue('embed-page', { tenantId: tenant.tenantId, pageId }, { singletonKey: `embed:${pageId}` });
      await vi.waitFor(async () => {
        const rows = (await db.sql(`select status, chunk_count, model from page_embedding_state where page_id = '${pageId}'`)) as { status: string; chunk_count: number; model: string }[];
        expect(rows).toEqual([{ status: 'ready', chunk_count: 3, model: modelKey(embedder.model) }]);
      }, { timeout: 60_000, interval: 500 });
      const chunks = (await db.sql(`select chunk_index, vector_dims(embedding) as dims, char_start from page_chunks where page_id = '${pageId}' order by chunk_index`)) as { chunk_index: number; dims: number; char_start: number }[];
      expect(chunks.map((c) => [c.chunk_index, c.dims])).toEqual([[0, 8], [1, 8], [2, 8]]);
      expect(chunks[0]?.char_start).toBe(0);
      expect(embedder.calls.flatMap((c) => c.texts)).toHaveLength(3);
    } finally {
      await queue.stop({ graceMs: 1000 });
      await runner.hook.run();
    }
  }, 120_000);
});
