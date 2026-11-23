import { vi, afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JobQueue } from '@tektum/grimoire-core/ports/job-queue';
import { jobQueueCaseNames, jobQueueConformance, type JobQueueHarness } from '@tektum/grimoire-core/testing/job-queue-conformance';
import type { PgBossJobQueue } from '../src/index.js';
import { createTestDatabase, databaseUrl, dropTestDatabase, installPgBoss, poolDatabase, startQueue } from './pgboss-support.js';

const DB = `grimoire_t_pgboss_conf_${String(process.pid)}`;
const NAMES = ['c-enqueue', 'c-delay', 'c-retry', 'c-retry-exhausted', 'c-retry-default', 'c-singleton', 'c-schedule', 'c-crash', 'c-tx'];
const database = poolDatabase(databaseUrl(DB));
let current: PgBossJobQueue | undefined;
const started: PgBossJobQueue[] = [];

async function fresh(): Promise<PgBossJobQueue> {
  const q = await startQueue(databaseUrl(DB), NAMES);
  started.push(q);
  return q;
}

const harness = (queue: PgBossJobQueue): JobQueueHarness => ({
  queue,
  database,
  async advance(seconds, until) {
    if (until) await vi.waitFor(() => { if (!until()) throw new Error('not yet'); }, { timeout: seconds * 1000 + 20_000, interval: 250 });
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
    current = await fresh();
  }, 60_000);
  afterAll(async () => {
    await Promise.all(started.map((q) => q.stop({ graceMs: 0 }).catch(() => undefined)));
    await database.close();
    await dropTestDatabase(DB);
  }, 60_000);

  it('lists the seven cases, in order', () => {
    expect(jobQueueConformance.map((c) => c.name)).toEqual([...jobQueueCaseNames]);
    console.log(`conformance cases: ${jobQueueConformance.map((c) => c.name).join(', ')}`);
  });
  for (const c of jobQueueConformance) {
    it(c.name, () => c.run(harness(current as PgBossJobQueue)), 180_000);
  }
});
