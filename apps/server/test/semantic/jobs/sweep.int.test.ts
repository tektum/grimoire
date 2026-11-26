import { randomUUID } from 'node:crypto';
import { createEmbeddingStore } from '@tektum/grimoire-adapter-db-kysely';
import type { EmbeddingStore } from '@tektum/grimoire-core/ports/embedding-store';
import { makeFakeConfig } from '@tektum/grimoire-core/testing/fake-config';
import { FakeEmbedder } from '@tektum/grimoire-core/testing/fake-embedder';
import { insertPage, raw } from '@tektum/grimoire-test-support/database';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { registerJobs } from '../../../src/jobs/index.js';
import { createJobRunner, type JobRunner } from '../../../src/jobs/runner.js';
import { appUrl } from '../../server/support/harness.js';
import { fakeJobDeps } from '../../jobs/deps.js';
import { jobsDatabase, runtimeQueue, seedTenant } from '../../jobs/support.js';

// M7-T13: the embed sweep through the real runner and queue, on the runtime role. Its runs are a chain: each sends the next one before its work (amendment 16a).
const DB = 'grimoire_m7t13_sweep';
let db: Awaited<ReturnType<typeof jobsDatabase>>;
const runners: JobRunner[] = [];
beforeAll(async () => { db = await jobsDatabase(DB); }, 120_000);
afterAll(async () => {
  for (const r of runners) await r.hook.run();
  await db?.drop();
});

/** The sweep's runs under its schedule key, by state. */
async function sweepRuns(): Promise<Record<string, number>> {
  const rows = (await db.sql(`select state::text as state, count(*)::int as n from pgboss.job where name = 'embed-sweep' and singleton_key = 'sched:embed-sweep' group by state`)) as { state: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.state, r.n]));
}

async function start(sweepSeconds: number, store: EmbeddingStore = createEmbeddingStore(db.app, db.ops)): Promise<JobRunner> {
  const config = makeFakeConfig({ database: { url: appUrl(DB) }, semantic: { sweepSeconds, debounceSeconds: 1 } });
  const { deps } = fakeJobDeps({ config, embedder: new FakeEmbedder({ maxTokens: 512, dims: 8 }), embeddings: store, tenants: { ids: async () => ((await db.sql('select id from tenants order by id')) as { id: string }[]).map((t) => t.id) } });
  const runner = createJobRunner({ config, log: deps.log, make: () => runtimeQueue(DB), jobs: (queue) => registerJobs({ ...deps, queue }) });
  runners.push(runner);
  await runner.start();
  expect(runner.state()).toBe('up');
  return runner;
}

async function stopAll(): Promise<void> {
  for (const r of runners.splice(0)) await r.hook.run();
  await db.sql(`delete from pgboss.job where name in ('embed-sweep', 'embed-page')`);
}

describe('the embed sweep, a chain of runs', () => {
  it('two replicas that start send one first run between them: the chain is one', async () => {
    await start(600);
    await start(600);
    expect(await sweepRuns()).toEqual({ created: 1 });
    await stopAll();
  }, 60_000);

  it('a run that fails has sent its next run already: the chain goes on, with one run waiting', async () => {
    const failing = { ...createEmbeddingStore(db.app, db.ops), pagesNeedingEmbedding: () => Promise.reject(new Error('store down')) };
    await start(1, failing);
    await vi.waitFor(async () => {
      const runs = await sweepRuns();
      expect(runs['retry']).toBe(1); // the run that failed, waiting for its retry
      expect(runs['created']).toBe(1); // the next run, sent before the work that failed
    }, { timeout: 30_000, interval: 200 });
    await stopAll();
  }, 60_000);

  it('embeds a page that was left alone with no one asking, and leaves a page that was just saved', async () => {
    const tenant = await seedTenant(db.sql, 'T-sweep');
    const page = (lastEdited: string) => ({ collection_id: tenant.collectionId, created_by: tenant.userId, tenant_id: tenant.tenantId, title: 'T', text_content: 'alpha beta gamma delta', markdown_hash: raw(`decode(repeat('0b', 32), 'hex')`), last_edited_at: raw(lastEdited) });
    const settled = randomUUID();
    const typing = randomUUID();
    await insertPage(db.sql, { id: settled, ...page(`now() - interval '5 minutes'`) });
    await insertPage(db.sql, { id: typing, ...page(`now() + interval '1 hour'`) });
    await start(1);
    await vi.waitFor(async () => {
      expect(await db.sql(`select status from page_embedding_state where page_id = '${settled}'`)).toEqual([{ status: 'ready' }]);
    }, { timeout: 60_000, interval: 500 });
    expect(await db.sql(`select status from page_embedding_state where page_id = '${typing}'`)).toEqual([]);
    await stopAll();
  }, 120_000);
});
