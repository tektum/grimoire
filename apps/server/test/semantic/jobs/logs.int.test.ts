import { randomUUID } from 'node:crypto';
import { createEmbeddingStore } from '@tektum/grimoire-adapter-db-kysely';
import { makeFakeConfig } from '@tektum/grimoire-core/testing/fake-config';
import { FakeEmbedder } from '@tektum/grimoire-core/testing/fake-embedder';
import { insertPage, raw } from '@tektum/grimoire-test-support/database';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { registerJobs } from '../../../src/jobs/index.js';
import { createJobRunner } from '../../../src/jobs/runner.js';
import { appUrl } from '../../server/support/harness.js';
import { fakeJobDeps } from '../../jobs/deps.js';
import { jobsDatabase, runtimeQueue, seedTenant } from '../../jobs/support.js';

// M7-T13 (R9.31): what the pages say never leaves their rows. A marker placed in the text of two pages, one embedded and one that fails, must be in no log line, no job row (payload or
// output), no state error, and no value of a stored vector in any of them; the payload of a job is the tenant and the page, nothing else.
const DB = 'grimoire_m7t13_logs';
const MARKER = 'zebra-marker-7741';
let db: Awaited<ReturnType<typeof jobsDatabase>>;
beforeAll(async () => { db = await jobsDatabase(DB); }, 120_000);
afterAll(async () => { await db?.drop(); });

describe('what the embedding jobs write down', () => {
  it('holds none of the text of a page, a marker in it, or a vector: not in the logs, the job rows or the states, for a page that was embedded and one that failed', async () => {
    const tenant = await seedTenant(db.sql, 'T-logs');
    const ids = [randomUUID(), randomUUID()];
    for (const id of ids) {
      await insertPage(db.sql, {
        id, collection_id: tenant.collectionId, created_by: tenant.userId, tenant_id: tenant.tenantId, title: `title ${MARKER}`, text_content: `${MARKER} alpha beta gamma ${id}`,
        markdown_hash: raw(`decode(repeat('0d', 32), 'hex')`), last_edited_at: raw(`now() - interval '5 minutes'`),
      });
    }
    const embedder = new FakeEmbedder({ maxTokens: 512, dims: 8 });
    embedder.failNext('internal'); // the first page that is asked for fails, the other is embedded
    const config = makeFakeConfig({ database: { url: appUrl(DB) }, semantic: { sweepSeconds: 1, debounceSeconds: 1 } });
    const { deps, logger } = fakeJobDeps({ config, embedder, embeddings: createEmbeddingStore(db.app, db.ops), tenants: { ids: () => Promise.resolve([tenant.tenantId]) } });
    const runner = createJobRunner({ config, log: deps.log, make: () => runtimeQueue(DB), jobs: (queue) => registerJobs({ ...deps, queue }) });
    await runner.start();
    try {
      await vi.waitFor(async () => {
        const states = (await db.sql(`select status from page_embedding_state order by status`)) as { status: string }[];
        expect(states.map((s) => s.status)).toEqual(['failed', 'ready']);
      }, { timeout: 60_000, interval: 500 });
    } finally {
      await runner.hook.run();
    }

    const jobs = (await db.sql(`select name, data::text as data, output::text as output from pgboss.job where name in ('embed-sweep', 'embed-page', 'dead-letter')`)) as { name: string; data: string | null; output: string | null }[];
    const states = (await db.sql(`select status, error from page_embedding_state`)) as { status: string; error: string | null }[];
    const [vector] = (await db.sql(`select embedding::text as v from page_chunks limit 1`)) as { v: string }[];
    const vectorStart = (vector?.v ?? '').slice(0, 20); // the first values of a stored vector
    expect(vectorStart.length).toBe(20);
    const written = { logs: JSON.stringify(logger.entries), jobs: JSON.stringify(jobs), states: JSON.stringify(states) };

    for (const [where, text] of Object.entries(written)) {
      expect(text.includes(MARKER), `the marker is in the ${where}`).toBe(false);
      expect(text.includes(vectorStart), `a vector is in the ${where}`).toBe(false);
    }
    expect(states.find((s) => s.status === 'failed')?.error).toBe('internal'); // a reason code, nothing else
    const pagePayloads = jobs.filter((j) => j.name === 'embed-page').map((j) => Object.keys(JSON.parse(j.data ?? 'null') as object).sort());
    expect(pagePayloads.length).toBeGreaterThan(0);
    for (const keys of pagePayloads) expect(keys).toEqual(['pageId', 'tenantId']);
    expect(logger.entries.some((e) => e.event === 'semantic.failed')).toBe(true); // the failure was logged, so the check above looked at something
  }, 120_000);
});
