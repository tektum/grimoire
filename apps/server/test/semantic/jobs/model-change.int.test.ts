import { randomUUID } from 'node:crypto';
import { createEmbeddingStore } from '@tektum/grimoire-adapter-db-kysely';
import { modelKey } from '@tektum/grimoire-core/semantic/model-key';
import { makeFakeConfig } from '@tektum/grimoire-core/testing/fake-config';
import { FakeEmbedder } from '@tektum/grimoire-core/testing/fake-embedder';
import { insertPage, raw } from '@tektum/grimoire-test-support/database';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { registerJobs } from '../../../src/jobs/index.js';
import { createJobRunner } from '../../../src/jobs/runner.js';
import { appUrl } from '../../server/support/harness.js';
import { fakeJobDeps } from '../../jobs/deps.js';
import { jobsDatabase, runtimeQueue, seedTenant } from '../../jobs/support.js';

// M7-T13: the model changes while pages are embedded: the real sweep and job replace the rows of the old model page by page, and say so once.
const DB = 'grimoire_m7t13_model_change';
const OLD_MODEL = 'old-model-v1';
let db: Awaited<ReturnType<typeof jobsDatabase>>;
beforeAll(async () => { db = await jobsDatabase(DB); }, 120_000);
afterAll(async () => { await db?.drop(); });

describe('a model change, through the runner', () => {
  it('embeds every page again under the new model, replaces the rows of the old one, and logs the start once', async () => {
    const tenant = await seedTenant(db.sql, 'T-model');
    const hash = new Uint8Array(32).fill(0x0b);
    const store = createEmbeddingStore(db.app, db.ops);
    const ids = Array.from({ length: 3 }, () => randomUUID());
    for (const id of ids) {
      await insertPage(db.sql, {
        id, collection_id: tenant.collectionId, created_by: tenant.userId, tenant_id: tenant.tenantId, title: 'T', text_content: `alpha beta gamma ${id}`,
        markdown_hash: raw(`decode(repeat('0b', 32), 'hex')`), last_edited_at: raw(`now() - interval '5 minutes'`),
      });
      // embedded before the change, under the old model
      await store.replacePage(tenant.tenantId, id, hash, OLD_MODEL, [{ chunkIndex: 0, contentHash: new Uint8Array(32).fill(1), charStart: 0, charEnd: 5, tokenCount: 3, embedding: new Float32Array(8).fill(0.1) }]);
    }
    const embedder = new FakeEmbedder({ maxTokens: 512, dims: 8 });
    const model = modelKey(embedder.model);
    expect(model).not.toBe(OLD_MODEL);
    expect(await store.counts(model)).toMatchObject({ pagesReady: 0, pagesOtherModel: 3 });

    const config = makeFakeConfig({ database: { url: appUrl(DB) }, semantic: { sweepSeconds: 1, debounceSeconds: 1 } });
    const { deps, logger } = fakeJobDeps({ config, embedder, embeddings: store, tenants: { ids: () => Promise.resolve([tenant.tenantId]) } });
    const runner = createJobRunner({ config, log: deps.log, make: () => runtimeQueue(DB), jobs: (queue) => registerJobs({ ...deps, queue }) });
    await runner.start();
    try {
      expect(runner.state()).toBe('up');
      await vi.waitFor(async () => { expect(await store.counts(model)).toMatchObject({ pagesReady: 3, pagesPending: 0, pagesOtherModel: 0 }); }, { timeout: 90_000, interval: 500 });
      const rows = (await db.sql(`select distinct model from page_chunks`)) as { model: string }[];
      expect(rows).toEqual([{ model }]); // the rows of the old model are gone
      expect(logger.entries.filter((e) => e.event === 'semantic.reembed_started').map((e) => e.fields)).toEqual([{ model, pages: 3 }]);
    } finally {
      await runner.hook.run();
    }
  }, 150_000);
});
