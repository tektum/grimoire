import path from 'node:path';
import pg from 'pg';
import { createJobQueue } from '@tektum/grimoire-adapter-jobs-pgboss';
import { jobQueues } from '@tektum/grimoire-core/jobs/queues';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { appUrl, createTestDatabase, dropTestDatabase, migratorUrl, requireBuild, runToEnd, serverDir, sqlAdmin } from '../../server/support/harness.js';

const DB = 'grimoire_m7t02_queues';
const migrate = () => runToEnd([path.join(serverDir, 'dist/cli.js'), 'migrate'], { GRIMOIRE_DATABASE_MIGRATION_URL: migratorUrl(DB) });

const queueRows = () => sqlAdmin<Record<string, unknown>>(DB,
  `select name, policy, retry_limit, retry_delay, retry_backoff, expire_seconds, retention_seconds, dead_letter, table_name from pgboss.queue order by name`);

beforeAll(async () => {
  requireBuild();
  await createTestDatabase(DB, false);
}, 60_000);
afterAll(async () => { await dropTestDatabase(DB); });

describe('grimoire migrate creates the job queues', () => {
  it('creates every queue of jobQueues() with its policy, retry numbers, expiry and dead-letter queue, and a second run changes nothing', async () => {
    const first = await migrate();
    expect(first.code, first.output).toBe(0);
    const rows = await queueRows();
    expect(rows.map((r) => [r.name, r.policy, r.retry_limit, r.retry_delay, r.retry_backoff, r.expire_seconds, r.retention_seconds, r.dead_letter])).toEqual(
      jobQueues().map((q) => [q.name, q.policy, q.retryLimit, q.retryDelaySeconds, q.retryBackoff, q.expireInSeconds, q.retentionSeconds, q.deadLetter ?? null]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
    const second = await migrate();
    expect(second.code, second.output).toBe(0);
    expect(await queueRows()).toEqual(rows);
  }, 120_000);

  it('lets the runtime role start the adapter, enqueue and complete a job in each queue, while creating a table is refused', async () => {
    const errors: Error[] = [];
    const queue = await createJobQueue({ connectionString: appUrl(DB), max: 4, onError: (e) => errors.push(e) });
    const done = new Set<string>();
    try {
      for (const { name } of jobQueues()) {
        await queue.work(name, async () => { done.add(name); });
        expect(await queue.enqueue(name, {}), name).toEqual(expect.any(String));
      }
      await vi.waitFor(() => expect([...done].sort()).toEqual(jobQueues().map((q) => q.name).sort()), { timeout: 60_000, interval: 500 });
    } finally {
      await queue.stop({ graceMs: 2000 });
    }
    expect(errors.map((e) => e.message)).toEqual([]);
    const client = new pg.Client({ connectionString: appUrl(DB) });
    await client.connect();
    try {
      await expect(client.query('create table x()')).rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.end();
    }
  }, 120_000);
});
