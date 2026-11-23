import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { PgBossJobQueue } from '../src/index.js';
import { createTestDatabase, databaseUrl, dropTestDatabase, installPgBoss, poolDatabase, startQueue } from './pgboss-support.js';

const DB = `grimoire_t_pgboss_exec_${String(process.pid)}`;
const database = poolDatabase(databaseUrl(DB));
let queue: PgBossJobQueue;

async function jobCount(payloadValue: string): Promise<number> {
  const client = new pg.Client({ connectionString: databaseUrl(DB) });
  await client.connect();
  try {
    const r = await client.query("select count(*)::int as n from pgboss.job where name = 'x-tx' and data->>'v' = $1", [payloadValue]);
    return (r.rows[0] as { n: number }).n;
  } finally {
    await client.end();
  }
}

describe('enqueue in the caller\'s transaction', () => {
  beforeAll(async () => {
    await createTestDatabase(DB);
    await installPgBoss(databaseUrl(DB));
    queue = await startQueue(databaseUrl(DB), ['x-tx']);
  }, 60_000);
  afterAll(async () => {
    await queue.stop({ graceMs: 0 });
    await database.close();
    await dropTestDatabase(DB);
  }, 60_000);

  it('leaves no job when the transaction rolls back', async () => {
    await expect(database.transaction(async (tx) => { await queue.enqueue('x-tx', { v: 'rolled' }, {}, tx); throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await jobCount('rolled')).toBe(0);
  });

  it('leaves the job when the transaction commits', async () => {
    await database.transaction(async (tx) => { await queue.enqueue('x-tx', { v: 'kept' }, {}, tx); });
    expect(await jobCount('kept')).toBe(1);
  });
});
