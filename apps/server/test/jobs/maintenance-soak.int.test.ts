import { PgBoss, type ConstructorOptions } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createJobQueue } from '@tektum/grimoire-adapter-jobs-pgboss';
import { appUrl } from '../server/support/harness.js';
import { jobsDatabase, makeQueue } from './support.js';

// M7-T02, decision 13: pg-boss's background loops (supervise and maintenance, and the cron loop) run for five minutes under the RUNTIME role, with their intervals
// cut to 10 s, and nothing they do is refused. If this fails, the cron/maintenance loops need a role of their own (contracts section 3): stop and report, do not loosen the grants.
const SOAK_MS = 5 * 60_000;
const INTERVAL_SECONDS = 10;
const PLAIN = 'soak-plain';
const CRON = 'soak-cron';

const shortLoops = (o: ConstructorOptions): PgBoss => new PgBoss({ ...o, supervise: true, superviseIntervalSeconds: INTERVAL_SECONDS, maintenanceIntervalSeconds: INTERVAL_SECONDS, monitorIntervalSeconds: INTERVAL_SECONDS });

const dbs = { plain: 'grimoire_m7t02_soak_a', cron: 'grimoire_m7t02_soak_b' };
let a: Awaited<ReturnType<typeof jobsDatabase>>;
let b: Awaited<ReturnType<typeof jobsDatabase>>;
beforeAll(async () => {
  [a, b] = await Promise.all([jobsDatabase(dbs.plain), jobsDatabase(dbs.cron)]);
}, 180_000);
afterAll(async () => { await Promise.all([a?.drop(), b?.drop()]); });

describe('the job queue on the runtime role, with the loops every 10 s', () => {
  it('runs supervise and maintenance for five minutes without a refusal, expires a stuck job, and fires a cron schedule', async () => {
    // Queues are made as `grimoire migrate` makes them; the runtime role only uses them.
    await makeQueue(dbs.plain, PLAIN, { expireInSeconds: 5, retentionSeconds: 3600 });
    await makeQueue(dbs.cron, CRON, { retentionSeconds: 3600 });
    const errors: string[] = [];
    const onError = (e: Error): void => { errors.push(e.message); };
    const plain = await createJobQueue({ connectionString: appUrl(dbs.plain), max: 4, onError }, shortLoops);
    const cron = await createJobQueue({ connectionString: appUrl(dbs.cron), max: 4, onError, cron: true }, shortLoops);
    try {
      let fired = 0;
      await plain.work(PLAIN, () => new Promise<void>(() => undefined)); // never finishes: only the expiry can end it
      await cron.work(CRON, () => { fired += 1; return Promise.resolve(); });
      await cron.schedule(CRON, '* * * * *');
      await plain.enqueue(PLAIN, { n: 1 });
      await new Promise((resolve) => setTimeout(resolve, SOAK_MS));
      const stuck = (await a.sql(`select state from pgboss.job where name = '${PLAIN}'`)) as { state: string }[];
      expect(stuck.map((r) => r.state), `errors: ${errors.join(' | ')}`).toEqual(['failed']);
      expect(fired, `the schedule fired ${String(fired)} times in five minutes; errors: ${errors.join(' | ')}`).toBeGreaterThanOrEqual(3);
      const stamps = (await b.sql(`select cron_on from pgboss.version`)) as { cron_on: Date | null }[];
      expect(stamps[0]?.cron_on, 'the cron loop took its turn').not.toBeNull();
      expect(errors, 'no loop reported an error').toEqual([]);
      expect(errors.join(' ')).not.toMatch(/permission denied/i);
    } finally {
      await Promise.all([plain.stop({ graceMs: 1500 }), cron.stop({ graceMs: 1500 })]);
    }
  }, SOAK_MS + 120_000);
});
