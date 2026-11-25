import { PgBoss, type ConstructorOptions } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createJobQueue } from '@tektum/grimoire-adapter-jobs-pgboss';
import { appUrl } from '../server/support/harness.js';
import { jobsDatabase, makeQueue } from './support.js';

// M7-T02, decision 13. Two facts about pg-boss under the RUNTIME role, measured here:
// 1. its supervise and maintenance loops run for five minutes, with their intervals cut to 10 s, and nothing they do is refused;
// 2. its cron loop cannot start: `Timekeeper.start` calls `create_queue`, which the runtime role may not run (contracts section 3). Schedules therefore need a process
//    with a role of its own, and the grants are not loosened to make it work.
const SOAK_MS = 5 * 60_000;
const INTERVAL_SECONDS = 10;
const PLAIN = 'soak-plain';

const shortLoops = (o: ConstructorOptions): PgBoss => new PgBoss({ ...o, supervise: true, superviseIntervalSeconds: INTERVAL_SECONDS, maintenanceIntervalSeconds: INTERVAL_SECONDS, monitorIntervalSeconds: INTERVAL_SECONDS });

const DB = 'grimoire_m7t02_soak';
let db: Awaited<ReturnType<typeof jobsDatabase>>;
beforeAll(async () => { db = await jobsDatabase(DB); }, 120_000);
afterAll(async () => { await db?.drop(); });

describe('the job queue on the runtime role', () => {
  it('runs supervise and maintenance every 10 s for five minutes without a refusal, and expires a stuck job', async () => {
    await makeQueue(DB, PLAIN, { expireInSeconds: 5, retentionSeconds: 3600 }); // made as `grimoire migrate` makes it
    const errors: string[] = [];
    const queue = await createJobQueue({ connectionString: appUrl(DB), max: 4, onError: (e) => { errors.push(e.message); } }, shortLoops);
    try {
      await queue.work(PLAIN, () => new Promise<void>(() => undefined)); // never finishes: only the expiry can end it
      await queue.enqueue(PLAIN, { n: 1 });
      await new Promise((resolve) => setTimeout(resolve, SOAK_MS));
      const rows = (await db.sql(`select state from pgboss.job where name = '${PLAIN}'`)) as { state: string }[];
      expect(rows.map((r) => r.state), `errors: ${errors.join(' | ')}`).toEqual(['failed']);
      expect(errors, 'no loop reported an error').toEqual([]);
    } finally {
      await queue.stop({ graceMs: 1500 });
    }
  }, SOAK_MS + 120_000);

  it('cannot start the cron loop: create_queue is refused (the fallback of contracts section 3: schedules run in a process with a role of their own)', async () => {
    await expect(createJobQueue({ connectionString: appUrl(DB), max: 2, onError: () => undefined, cron: true }, shortLoops)).rejects.toThrow(/permission denied for function create_queue/);
  }, 60_000);
});
