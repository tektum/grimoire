import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_STOP_GRACE_MS, PGBOSS_SCHEMA, PgBossJobQueue, createJobQueue, type PgBossLike } from '../src/index.js';

function stub() {
  const boss = {
    start: vi.fn(async () => boss),
    stop: vi.fn(async () => {}),
    send: vi.fn(async () => 'id-1'),
    work: vi.fn(async () => 'worker-1'),
    schedule: vi.fn(async () => {}),
    createQueue: vi.fn(async () => {}),
    getQueue: vi.fn(async () => null),
    isInstalled: vi.fn(async () => true),
  };
  return boss as typeof boss & PgBossLike;
}

describe('PgBossJobQueue', () => {
  it('maps enqueue options to pg-boss send options', async () => {
    const boss = stub();
    const id = await new PgBossJobQueue(boss).enqueue('n', { a: 1 }, { delaySeconds: 3, singletonKey: 'k', retryLimit: 2 });
    expect(id).toBe('id-1');
    expect(boss.send).toHaveBeenCalledWith('n', { a: 1 }, { startAfter: 3, singletonKey: 'k', retryLimit: 2 });
  });

  it('sends bare options when none are given and passes null through for a duplicate singleton', async () => {
    const boss = stub();
    boss.send.mockResolvedValueOnce(null as never);
    expect(await new PgBossJobQueue(boss).enqueue('n', {})).toBeNull();
    expect(boss.send).toHaveBeenCalledWith('n', {}, {});
  });

  it('runs a transactional enqueue on the given transaction', async () => {
    const boss = stub();
    const query = vi.fn(async () => [{ id: 'x' }]);
    boss.send.mockImplementationOnce((async (_n: string, _d: unknown, o: { db: { executeSql(t: string, v?: unknown[]): Promise<{ rows: unknown[] }> } }) => {
      expect(await o.db.executeSql('select 1', [7])).toEqual({ rows: [{ id: 'x' }] });
      return 'id-2';
    }) as never);
    expect(await new PgBossJobQueue(boss).enqueue('n', {}, {}, { query })).toBe('id-2');
    expect(query).toHaveBeenCalledWith('select 1', [7]);
  });

  it('hands each fetched job to the handler with a one-based attempt', async () => {
    const boss = stub();
    const seen: unknown[] = [];
    await new PgBossJobQueue(boss).work<{ v: number }>('n', async (p, ctx) => { seen.push([p, ctx]); });
    const run = boss.work.mock.calls[0]?.[1] as unknown as (jobs: unknown[]) => Promise<void>;
    await run([{ id: 'j1', data: { v: 1 }, retryCount: 0 }, { id: 'j2', data: { v: 2 }, retryCount: 2 }]);
    expect(seen).toEqual([[{ v: 1 }, { id: 'j1', attempt: 1 }], [{ v: 2 }, { id: 'j2', attempt: 3 }]]);
  });

  it('lets a handler failure reach pg-boss, which retries or fails the job', async () => {
    const boss = stub();
    await new PgBossJobQueue(boss).work('n', async () => { throw new Error('nope'); });
    const run = boss.work.mock.calls[0]?.[1] as unknown as (jobs: unknown[]) => Promise<void>;
    await expect(run([{ id: 'j', data: {}, retryCount: 0 }])).rejects.toThrow('nope');
  });

  it('schedules in UTC with a null payload by default', async () => {
    const boss = stub();
    const q = new PgBossJobQueue(boss);
    await q.schedule('n', '* * * * *');
    await q.schedule('m', '0 3 * * *', { x: 1 });
    expect(boss.schedule).toHaveBeenNthCalledWith(1, 'n', '* * * * *', null, { tz: 'UTC' });
    expect(boss.schedule).toHaveBeenNthCalledWith(2, 'm', '0 3 * * *', { x: 1 }, { tz: 'UTC' });
  });

  it('ensureQueue creates a missing queue once and leaves an existing one alone', async () => {
    const boss = stub();
    const q = new PgBossJobQueue(boss);
    await q.ensureQueue('a');
    await q.ensureQueue('b', { singleton: true, expireInSeconds: 5 });
    boss.getQueue.mockResolvedValueOnce({} as never);
    await q.ensureQueue('c');
    expect(boss.createQueue.mock.calls).toEqual([['a', { policy: 'standard' }], ['b', { policy: 'exclusive', expireInSeconds: 5 }]]);
  });

  it('isLive is false when pg-boss cannot answer', async () => {
    const boss = stub();
    const q = new PgBossJobQueue(boss);
    expect(await q.isLive()).toBe(true);
    boss.isInstalled.mockRejectedValueOnce(new Error('down'));
    expect(await q.isLive()).toBe(false);
  });

  it('stop waits a bounded grace and closes', async () => {
    const boss = stub();
    const q = new PgBossJobQueue(boss);
    await q.stop();
    await q.stop({ graceMs: 100 });
    expect(boss.stop.mock.calls).toEqual([[{ graceful: true, close: true, timeout: DEFAULT_STOP_GRACE_MS }], [{ graceful: true, close: true, timeout: 100 }]]);
  });
});

describe('createJobQueue', () => {
  it('starts pg-boss with migrate off, its own schema and no migration of its own', async () => {
    const boss = stub();
    const make = vi.fn(() => boss);
    await createJobQueue({ connectionString: 'postgresql://example/db' }, make);
    await createJobQueue({ connectionString: 'postgresql://example/db', max: 4 }, make);
    expect(make).toHaveBeenNthCalledWith(1, { connectionString: 'postgresql://example/db', schema: PGBOSS_SCHEMA, migrate: false });
    expect(make).toHaveBeenNthCalledWith(2, { connectionString: 'postgresql://example/db', schema: PGBOSS_SCHEMA, migrate: false, max: 4 });
    expect(boss.start).toHaveBeenCalledTimes(2);
  });

  it('uses the stop grace given at creation as the default of stop', async () => {
    const boss = stub();
    const q = await createJobQueue({ connectionString: 'postgresql://example/db', stopGraceMs: 700 }, () => boss);
    await q.stop();
    expect(boss.stop).toHaveBeenCalledWith({ graceful: true, close: true, timeout: 700 });
  });

  it('builds a real PgBoss by default without connecting until started', async () => {
    await expect(createJobQueue({ connectionString: 'postgresql://127.0.0.1:1/none' })).rejects.toThrow();
  });
});
