import { vi, afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { JobQueue } from '@tektum/grimoire-core/ports/job-queue';
import { jobQueueCaseNames, jobQueueConformance, type JobQueueHarness } from '@tektum/grimoire-core/testing/job-queue-conformance';
import type { PgBossJobQueue } from '../src/index.js';
import { createTestDatabase, databaseUrl, dropTestDatabase, installPgBoss, poolDatabase, startQueue } from './pgboss-support.js';

const DB = `grimoire_t_pgboss_conf_${String(process.pid)}`;
const database = poolDatabase(databaseUrl(DB));
let current: PgBossJobQueue | undefined;
const started: PgBossJobQueue[] = [];

async function fresh(): Promise<PgBossJobQueue> {
  const q = await startQueue(databaseUrl(DB));
  started.push(q);
  return q;
}

const harness = (queue: PgBossJobQueue): JobQueueHarness => ({
  queue,
  database,
  async advance(seconds, until) {
    if (until) {
      await vi.waitFor(() => { if (!until()) throw new Error('not yet'); }, { timeout: seconds * 1000 + 20_000, interval: 250 });
      return;
    }
    // Nothing to wait for: let the real clock run for `seconds`, so a job that wrongly runs (or runs again) shows up.
    const end = Date.now() + seconds * 1000;
    await vi.waitFor(() => { if (Date.now() < end) throw new Error('time has not passed'); }, { timeout: seconds * 1000 + 5000, interval: 250 });
  },
  async crashWorkers() {
    // Stop without waiting for running jobs: the job stays "active" until its expiry (5 s) and supervision gives it back.
    await (current as PgBossJobQueue).stop({ graceMs: 0 });
    current = await fresh();
    return current as JobQueue;
  },
});

describe('PgBossJobQueue conformance (same cases as the fake)', () => {
  beforeAll(async () => {
    await createTestDatabase(DB);
    await installPgBoss(databaseUrl(DB));
  }, 60_000);
  // A case may stop its queue, so each one gets its own.
  beforeEach(async () => { current = await fresh(); }, 60_000);
  afterEach(async () => { await Promise.all(started.splice(0).map((q) => q.stop({ graceMs: 0 }).catch(() => undefined))); }, 60_000);
  afterAll(async () => {
    await database.close();
    await dropTestDatabase(DB);
  }, 60_000);

  it('lists the cases, in order', () => {
    expect(jobQueueConformance.map((c) => c.name)).toEqual([...jobQueueCaseNames]);
    console.log(`conformance cases: ${jobQueueConformance.map((c) => c.name).join(', ')}`);
  });
  for (const c of jobQueueConformance) {
    it(c.name, () => c.run(harness(current as PgBossJobQueue)), 180_000);
  }
});
