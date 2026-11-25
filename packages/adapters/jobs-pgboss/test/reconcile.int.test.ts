import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import type { QueueDefinition } from '@tektum/grimoire-core/ports/job-queue';
import { migratePgBoss } from '../src/migrate.js';
import { createTestDatabase, databaseUrl, dropTestDatabase, poolDatabase, startQueue } from './pgboss-support.js';

// M7-T02 decision 16: a queue made with another policy is replaced by `grimoire migrate`, so the scheduled queues can be `stately` (one waiting run per key).
const DB = `grimoire_t_pgboss_reconcile_${String(process.pid)}`;
const database = poolDatabase(databaseUrl(DB));
const def = (name: string, policy: QueueDefinition['policy']): QueueDefinition => ({ name, policy, retryLimit: 0, retryDelaySeconds: 1, retryBackoff: false, expireInSeconds: 600, retentionSeconds: 3600 });
const migrate = (queues: QueueDefinition[], dropped: unknown[] = []) =>
  migratePgBoss({ connectionString: databaseUrl(DB), database, runtimeRole: 'grimoire_app', queues, onQueueRecreated: (e) => dropped.push(e) });

async function rows<Row>(sql: string, params: unknown[] = []): Promise<Row[]> {
  const client = new pg.Client({ connectionString: databaseUrl(DB) });
  await client.connect();
  try { return (await client.query(sql, params)).rows as Row[]; } finally { await client.end(); }
}

beforeAll(async () => { await createTestDatabase(DB); }, 60_000);
afterAll(async () => { await database.close(); await dropTestDatabase(DB); }, 60_000);

describe('a queue found with another policy', () => {
  it('is recreated as stately with its waiting jobs dropped and reported, and then one waiting run per key holds', async () => {
    await migrate([def('r-purge', 'singleton')]);
    const queue = await startQueue(databaseUrl(DB));
    try {
      await queue.enqueue('r-purge', {});
      await queue.enqueue('r-purge', {}, { delaySeconds: 3600 });
      const dropped: unknown[] = [];
      await migrate([def('r-purge', 'stately')], dropped);
      expect(dropped).toEqual([{ queue: 'r-purge', from: 'singleton', to: 'stately', pending: 2, finished: 0 }]);
      expect(await rows(`select policy from pgboss.queue where name = 'r-purge'`)).toEqual([{ policy: 'stately' }]);
      expect(await rows(`select count(*)::int as n from pgboss.job where name = 'r-purge'`)).toEqual([{ n: 0 }]);
      const first = await queue.enqueue('r-purge', {}, { singletonKey: 'sched:r-purge', delaySeconds: 3600 });
      const second = await queue.enqueue('r-purge', {}, { singletonKey: 'sched:r-purge', delaySeconds: 3600 });
      expect(second).toBe(first);
      expect(await rows(`select count(*)::int as n from pgboss.job where name = 'r-purge' and state = 'created'`)).toEqual([{ n: 1 }]);
      const again: unknown[] = [];
      await migrate([def('r-purge', 'stately')], again); // a second run finds the wanted policy and leaves the queue and its job alone
      expect(again).toEqual([]);
      expect(await rows(`select count(*)::int as n from pgboss.job where name = 'r-purge'`)).toEqual([{ n: 1 }]);
    } finally {
      await queue.stop({ graceMs: 0 });
    }
  }, 90_000);

  it('is left as it is, with an error that names it, while one of its jobs is running', async () => {
    await migrate([def('r-busy', 'singleton')]);
    const queue = await startQueue(databaseUrl(DB));
    try {
      await queue.work('r-busy', () => new Promise<void>(() => undefined));
      await queue.enqueue('r-busy', {});
      await vi.waitFor(async () => { expect(await rows(`select state from pgboss.job where name = 'r-busy'`)).toEqual([{ state: 'active' }]); }, { timeout: 20_000, interval: 250 });
      const dropped: unknown[] = [];
      await expect(migrate([def('r-busy', 'stately')], dropped)).rejects.toThrow(/r-busy.*active/);
      expect(dropped).toEqual([]);
      expect(await rows(`select policy from pgboss.queue where name = 'r-busy'`)).toEqual([{ policy: 'singleton' }]);
      expect(await rows(`select count(*)::int as n from pgboss.job where name = 'r-busy'`)).toEqual([{ n: 1 }]);
    } finally {
      await queue.stop({ graceMs: 0 });
    }
  }, 90_000);

  it('waits for a worker that is claiming a job and then sees it as active: the check and the deletion cannot be split by a claim', async () => {
    await migrate([def('r-race', 'singleton')]);
    const queue = await startQueue(databaseUrl(DB));
    const worker = new pg.Client({ connectionString: databaseUrl(DB) }); // a running server's fetch: it holds the job row while it moves it to active
    await worker.connect();
    try {
      await queue.enqueue('r-race', {});
      await worker.query('begin');
      await worker.query(`select id from pgboss.job where name = 'r-race' for update`);
      const dropped: unknown[] = [];
      const migrating = migrate([def('r-race', 'stately')], dropped).catch((e: unknown) => e as Error);
      await vi.waitFor(async () => {
        expect(await rows(`select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%for update%' and pid <> pg_backend_pid()`)).toHaveLength(1);
      }, { timeout: 20_000, interval: 100 });
      await worker.query(`update pgboss.job set state = 'active' where name = 'r-race'`);
      await worker.query('commit');
      expect(((await migrating) as Error).message).toMatch(/r-race.*active/);
      expect(dropped).toEqual([]);
      expect(await rows(`select policy from pgboss.queue where name = 'r-race'`)).toEqual([{ policy: 'singleton' }]);
    } finally {
      await worker.end();
      await queue.stop({ graceMs: 0 });
    }
  }, 90_000);
});
