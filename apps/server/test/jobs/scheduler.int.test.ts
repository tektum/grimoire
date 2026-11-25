import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { jobsDatabase, makeQueue, runtimeQueue } from './support.js';

// M7-T02 decision 16: schedules are a chain of sends on the RUNTIME role (pg-boss's cron loop cannot start there, see maintenance-soak.int.test.ts).
const DB = 'grimoire_m7t02_scheduler';
const Q = 'sched-test';
let db: Awaited<ReturnType<typeof jobsDatabase>>;
beforeAll(async () => {
  db = await jobsDatabase(DB);
  await makeQueue(DB, Q, { policy: 'stately', retryLimit: 0 });
}, 120_000);
afterAll(async () => { await db?.drop(); });

const waiting = async (): Promise<{ start_after: Date }[]> => (await db.sql(`select start_after from pgboss.job where name = '${Q}' and singleton_key = 'sched:${Q}' and state = 'created' order by start_after`)) as { start_after: Date }[];

describe('the schedule of a queue, on the runtime role', () => {
  it('keeps one waiting run for two replicas and for a restart, replaces one that no longer fits the cron, and goes on after a run that is still going and one that fails', async () => {
    const a = await runtimeQueue(DB);
    const b = await runtimeQueue(DB); // a second replica
    try {
      await a.schedule(Q, '0 3 * * *');
      await b.schedule(Q, '0 3 * * *');
      await a.schedule(Q, '0 3 * * *'); // a restart
      expect((await waiting()).map((r) => r.start_after.getUTCHours())).toEqual([3]);

      await b.schedule(Q, '0 4 * * *'); // the cron changed: the run of 03:00 is replaced, not kept
      expect((await waiting()).map((r) => r.start_after.getUTCHours())).toEqual([4]);
      expect(await db.sql(`select count(*)::int as n from pgboss.job where name = '${Q}' and state = 'cancelled'`)).toEqual([{ n: 1 }]);

      await db.sql(`delete from pgboss.job where name = '${Q}'`); // the waiting run is gone (expired, or lost)
      await a.schedule(Q, '* * * * *');
      expect(await waiting()).toHaveLength(1);

      let runs = 0;
      let during = -1;
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      await a.work(Q, async () => {
        runs += 1;
        if (runs === 1) {
          during = (await waiting()).length; // this run is active; its successor already waits
          await gate;
        }
        throw new Error('this run fails'); // retryLimit 0: it goes to dead-letter, and the schedule must not end with it
      });
      await vi.waitFor(() => { expect(during).toBeGreaterThanOrEqual(0); }, { timeout: 90_000, interval: 500 }); // set after the count of runs, once the handler has looked
      expect(during).toBe(1);
      release();
      await vi.waitFor(() => { expect(runs).toBe(2); }, { timeout: 90_000, interval: 500 }); // the successor ran, a minute later
    } finally {
      await Promise.all([a.stop({ graceMs: 1500 }), b.stop({ graceMs: 1500 })]);
    }
  }, 240_000);
});
