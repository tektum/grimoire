import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeFakeConfig } from '@tektum/grimoire-core/testing/fake-config';
import { createJobRunner } from '../../src/jobs/runner.js';
import { registerJobs } from '../../src/jobs/index.js';
import { appUrl } from '../server/support/harness.js';
import { fakeJobDeps } from './deps.js';
import { jobsDatabase, runtimeQueue } from './support.js';

// M7-T02 decision 16, end to end: the queues as `grimoire migrate` makes them (stately), the jobs of the registry, two replicas starting on the runtime role.
const DB = 'grimoire_m7t02_runner_schedules';
let db: Awaited<ReturnType<typeof jobsDatabase>>;
beforeAll(async () => { db = await jobsDatabase(DB); }, 120_000);
afterAll(async () => { await db?.drop(); });

describe('two replicas starting the job runner', () => {
  it('leave one waiting run for each scheduled job, each at a time of its cron, and none for the jobs that only get enqueued or are not real yet', async () => {
    const config = makeFakeConfig({ database: { url: appUrl(DB) } });
    const { deps } = fakeJobDeps({ config });
    const jobs = registerJobs(deps);
    const runners = [0, 1].map(() => createJobRunner({ config, log: deps.log, make: () => runtimeQueue(DB), jobs }));
    await Promise.all(runners.map((r) => r.start()));
    try {
      expect(runners.map((r) => r.state())).toEqual(['up', 'up']);
      const rows = (await db.sql(`select name, singleton_key, count(*)::int as n from pgboss.job where state = 'created' and singleton_key like 'sched:%' group by name, singleton_key order by name`)) as { name: string; singleton_key: string; n: number }[];
      expect(rows).toEqual(jobs.filter((j) => j.schedule !== undefined).map((j) => ({ name: j.name, singleton_key: `sched:${j.name}`, n: 1 })).sort((a, b) => (a.name < b.name ? -1 : 1)));
      expect(rows.map((r) => r.name)).toEqual(['markdown-sweep', 'purge', 'revision-catchup', 'upload-cleanup']); // the stubs are not scheduled
    } finally {
      await Promise.all(runners.map((r) => r.hook.run()));
    }
  }, 120_000);
});
