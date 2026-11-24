import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueueDefinition } from '@tektum/grimoire-core/ports/job-queue';
import { DEFAULT_STOP_GRACE_MS, PGBOSS_SCHEMA, PgBossJobQueue, createJobQueue, type PgBossLike } from '../src/index.js';

function stub() {
  const boss = {
    start: vi.fn(async () => boss),
    stop: vi.fn(async () => {}),
    send: vi.fn(async () => 'id-1'),
    work: vi.fn<(...args: unknown[]) => Promise<string>>(async () => 'worker-1'),
    schedule: vi.fn(async () => {}),
    createQueue: vi.fn(async () => {}),
    getQueue: vi.fn(async () => null),
    findJobs: vi.fn<(...args: unknown[]) => Promise<{ id: string; state: string }[]>>(async () => []),
    isInstalled: vi.fn(async () => true),
    on: vi.fn(() => boss),
  };
  return boss as typeof boss & PgBossLike;
}

const DEFINITION: QueueDefinition = { name: 'q', policy: 'stately', retryLimit: 3, retryDelaySeconds: 30, retryBackoff: true, expireInSeconds: 900, retentionSeconds: 1000, deadLetter: 'dead' };

afterEach(() => { vi.useRealTimers(); });

describe('PgBossJobQueue', () => {
  it('maps enqueue options to pg-boss send options', async () => {
    const boss = stub();
    const id = await new PgBossJobQueue(boss).enqueue('n', { a: 1 }, { delaySeconds: 3, singletonKey: 'k', retryLimit: 2, expireInSeconds: 40 });
    expect(id).toBe('id-1');
    expect(boss.send).toHaveBeenCalledWith('n', { a: 1 }, { startAfter: 3, singletonKey: 'k', retryLimit: 2, expireInSeconds: 40 });
  });

  it('leaves retries and expiry to the queue when the send names none', async () => {
    const boss = stub();
    await new PgBossJobQueue(boss).enqueue('n', {});
    expect(boss.send).toHaveBeenCalledWith('n', {}, {});
  });

  it('answers a taken singleton key with the queued job that holds it, or null when there is none', async () => {
    const boss = stub();
    const q = new PgBossJobQueue(boss);
    boss.send.mockResolvedValue(null as never);
    boss.findJobs.mockResolvedValueOnce([{ id: 'held', state: 'created' }]);
    expect(await q.enqueue('n', {}, { singletonKey: 'k' })).toBe('held');
    expect(boss.findJobs).toHaveBeenCalledWith('n', { key: 'k', queued: true, limit: 1 });
    expect(await q.enqueue('n', {}, { singletonKey: 'k' })).toBeNull();
    expect(await q.enqueue('n', {})).toBeNull();
    expect(boss.findJobs).toHaveBeenCalledTimes(2);
  });

  it('runs a transactional enqueue on the given transaction', async () => {
    const boss = stub();
    const query = vi.fn(async () => [{ id: 'x' }]);
    boss.send.mockImplementationOnce((async (_n: string, _d: unknown, o: { db: { executeSql(t: string, v?: unknown[]): Promise<{ rows: unknown[] }> } }) => {
      expect(await o.db.executeSql('select 1', [7])).toEqual({ rows: [{ id: 'x' }] });
      return 'id-2';
    }) as never);
    expect(await new PgBossJobQueue(boss).enqueue('n', {}, {}, { query: query as never })).toBe('id-2');
    expect(query).toHaveBeenCalledWith('select 1', [7]);
  });

  it('hands each fetched job to the handler with a one-based attempt, its retry limit and a live signal', async () => {
    const boss = stub();
    const seen: unknown[] = [];
    await new PgBossJobQueue(boss).work<{ v: number }>('n', async (p, ctx) => { seen.push([p, ctx.jobId, ctx.attempt, ctx.retryLimit, ctx.signal.aborted]); });
    expect(boss.work.mock.calls[0]?.[1]).toEqual({ includeMetadata: true });
    const run = boss.work.mock.calls[0]?.[2] as unknown as (jobs: unknown[]) => Promise<void>;
    await run([
      { id: 'j1', data: { v: 1 }, retryCount: 0, retryLimit: 3, expireInSeconds: 900 },
      { id: 'j2', data: { v: 2 }, retryCount: 2, retryLimit: 3, expireInSeconds: 900 },
    ]);
    expect(seen).toEqual([[{ v: 1 }, 'j1', 1, 3, false], [{ v: 2 }, 'j2', 3, 3, false]]);
  });

  it('lets a handler failure reach pg-boss, which retries or fails the job', async () => {
    const boss = stub();
    await new PgBossJobQueue(boss).work('n', async () => { throw new Error('nope'); });
    const run = boss.work.mock.calls[0]?.[2] as unknown as (jobs: unknown[]) => Promise<void>;
    await expect(run([{ id: 'j', data: {}, retryCount: 0, retryLimit: 0, expireInSeconds: 900 }])).rejects.toThrow('nope');
  });

  it('aborts the signal before the expiry, and also when pg-boss aborts its own', async () => {
    vi.useFakeTimers();
    const boss = stub();
    const aborted: boolean[] = [];
    await new PgBossJobQueue(boss).work('n', async (_p, ctx) => {
      await new Promise<void>((resolve) => { ctx.signal.addEventListener('abort', () => { resolve(); }, { once: true }); });
      aborted.push(ctx.signal.aborted);
    });
    const run = boss.work.mock.calls[0]?.[2] as unknown as (jobs: unknown[]) => Promise<void>;
    const done = run([{ id: 'j', data: {}, retryCount: 0, retryLimit: 0, expireInSeconds: 600 }]);
    await vi.advanceTimersByTimeAsync(539_000);
    expect(aborted).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    await done;
    expect(aborted).toEqual([true]);
    const theirs = new AbortController();
    const second = run([{ id: 'k', data: {}, retryCount: 0, retryLimit: 0, expireInSeconds: 600, signal: theirs.signal }]);
    theirs.abort();
    await second;
    expect(aborted).toEqual([true, true]);
  });

  it('schedules in UTC with a null payload by default', async () => {
    const boss = stub();
    const q = new PgBossJobQueue(boss);
    await q.schedule('n', '* * * * *');
    await q.schedule('m', '0 3 * * *', { x: 1 });
    expect(boss.schedule).toHaveBeenNthCalledWith(1, 'n', '* * * * *', null, { tz: 'UTC' });
    expect(boss.schedule).toHaveBeenNthCalledWith(2, 'm', '0 3 * * *', { x: 1 }, { tz: 'UTC' });
  });

  it('ensureQueue creates a missing queue from its definition once and leaves an existing one alone', async () => {
    const boss = stub();
    const q = new PgBossJobQueue(boss);
    await q.ensureQueue(DEFINITION);
    await q.ensureQueue({ name: 'p', policy: 'standard', retryLimit: 3, retryDelaySeconds: 30, retryBackoff: true, expireInSeconds: 900, retentionSeconds: 1000 });
    boss.getQueue.mockResolvedValueOnce({} as never);
    await q.ensureQueue({ ...DEFINITION, name: 'c' });
    expect(boss.createQueue.mock.calls).toEqual([
      ['q', { policy: 'stately', retryLimit: 3, retryDelay: 30, retryBackoff: true, expireInSeconds: 900, retentionSeconds: 1000, deadLetter: 'dead' }],
      ['p', { policy: 'standard', retryLimit: 3, retryDelay: 30, retryBackoff: true, expireInSeconds: 900, retentionSeconds: 1000 }],
    ]);
  });

  it('isLive is true while a job with the key is queued, waiting for a retry or running', async () => {
    const boss = stub();
    const q = new PgBossJobQueue(boss);
    expect(await q.isLive('n', 'k')).toBe(false);
    boss.findJobs.mockResolvedValueOnce([{ id: '1', state: 'completed' }, { id: '2', state: 'failed' }, { id: '3', state: 'cancelled' }]);
    expect(await q.isLive('n', 'k')).toBe(false);
    for (const state of ['created', 'retry', 'active']) {
      boss.findJobs.mockResolvedValueOnce([{ id: '1', state: 'completed' }, { id: '2', state }]);
      expect(await q.isLive('n', 'k')).toBe(true);
    }
    expect(boss.findJobs).toHaveBeenCalledWith('n', { key: 'k', limit: 100_000 });
  });

  it('isReady is false when pg-boss cannot answer', async () => {
    const boss = stub();
    const q = new PgBossJobQueue(boss);
    expect(await q.isReady()).toBe(true);
    boss.isInstalled.mockRejectedValueOnce(new Error('down'));
    expect(await q.isReady()).toBe(false);
  });

  it('stop waits a bounded grace and closes', async () => {
    const boss = stub();
    const q = new PgBossJobQueue(boss);
    expect(await q.stop()).toEqual({ inFlight: 0 });
    await q.stop({ graceMs: 100 });
    expect(boss.stop.mock.calls).toEqual([[{ graceful: true, close: true, timeout: DEFAULT_STOP_GRACE_MS }], [{ graceful: true, close: true, timeout: 100 }]]);
  });

  it('stop aborts the signals of running handlers two seconds before the grace ends and counts those that are still running', async () => {
    vi.useFakeTimers();
    const boss = stub();
    const q = new PgBossJobQueue(boss);
    let release = (): void => {};
    const signals: AbortSignal[] = [];
    await q.work('n', async (_p, ctx) => { signals.push(ctx.signal); await new Promise<void>((resolve) => { release = resolve; }); });
    const run = boss.work.mock.calls[0]?.[2] as unknown as (jobs: unknown[]) => Promise<void>;
    const running = run([{ id: 'j', data: {}, retryCount: 0, retryLimit: 0, expireInSeconds: 900 }]);
    boss.stop.mockImplementationOnce((async () => { await vi.advanceTimersByTimeAsync(5000); }) as never);
    expect(await q.stop({ graceMs: 5000 })).toEqual({ inFlight: 1 });
    expect(signals[0]?.aborted).toBe(true);
    release();
    await running;
    boss.stop.mockImplementationOnce((async () => { await vi.advanceTimersByTimeAsync(10); }) as never);
    expect(await q.stop({ graceMs: 1000 })).toEqual({ inFlight: 0 });
  });
});

describe('createJobQueue', () => {
  const onError = vi.fn();

  it('listens for pg-boss errors before it starts, so one cannot end the process', async () => {
    const boss = stub();
    const order: string[] = [];
    boss.on.mockImplementation((() => { order.push('on'); return boss; }) as never);
    boss.start.mockImplementation((async () => { order.push('start'); return boss; }) as never);
    await createJobQueue({ connectionString: 'postgresql://example/db', onError }, () => boss);
    expect(order).toEqual(['on', 'start']);
    expect(boss.on).toHaveBeenCalledWith('error', onError);
  });

  it('starts pg-boss with migrate off, its own schema and no migration of its own', async () => {
    const boss = stub();
    const make = vi.fn(() => boss);
    await createJobQueue({ connectionString: 'postgresql://example/db', onError }, make);
    await createJobQueue({ connectionString: 'postgresql://example/db', onError, max: 4 }, make);
    expect(make).toHaveBeenNthCalledWith(1, { connectionString: 'postgresql://example/db', schema: PGBOSS_SCHEMA, migrate: false, schedule: false });
    expect(make).toHaveBeenNthCalledWith(2, { connectionString: 'postgresql://example/db', schema: PGBOSS_SCHEMA, migrate: false, schedule: false, max: 4 });
    expect(boss.start).toHaveBeenCalledTimes(2);
  });

  it('turns the cron loop on only when asked', async () => {
    const boss = stub();
    const make = vi.fn(() => boss);
    await createJobQueue({ connectionString: 'postgresql://example/db', onError, cron: true }, make);
    expect(make).toHaveBeenCalledWith(expect.objectContaining({ schedule: true }));
  });

  it('uses the stop grace given at creation as the default of stop', async () => {
    const boss = stub();
    const q = await createJobQueue({ connectionString: 'postgresql://example/db', onError, stopGraceMs: 700 }, () => boss);
    await q.stop();
    expect(boss.stop).toHaveBeenCalledWith({ graceful: true, close: true, timeout: 700 });
  });

  it('builds a real PgBoss by default without connecting until started', async () => {
    await expect(createJobQueue({ connectionString: 'postgresql://127.0.0.1:1/none', onError })).rejects.toThrow();
  });
});
