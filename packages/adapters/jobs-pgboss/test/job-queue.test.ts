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
    cancel: vi.fn(async () => ({})),
    createQueue: vi.fn(async () => {}),
    getQueue: vi.fn(async () => null),
    findJobs: vi.fn<(...args: unknown[]) => Promise<{ id: string; startAfter?: Date }[]>>(async () => []),
    getDb: vi.fn(() => ({ executeSql: vi.fn<(...args: unknown[]) => Promise<{ rows: unknown[] }>>(async () => ({ rows: [] })) })),
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
    boss.findJobs.mockResolvedValueOnce([{ id: 'held' }]);
    expect(await q.enqueue('n', {}, { singletonKey: 'k' })).toBe('held');
    expect(boss.findJobs).toHaveBeenCalledWith('n', { key: 'k', queued: true, limit: 1 });
    expect(await q.enqueue('n', {}, { singletonKey: 'k' })).toBeNull();
    expect(await q.enqueue('n', {})).toBeNull();
    expect(boss.findJobs).toHaveBeenCalledTimes(2);
  });

  it('looks the holder of a taken key up in the caller\'s transaction when there is one', async () => {
    const boss = stub();
    boss.send.mockResolvedValue(null as never);
    const query = vi.fn(async () => [{ id: 'mine' }]);
    boss.findJobs.mockImplementationOnce((async (_n: string, o: { db: { executeSql(t: string, v?: unknown[]): Promise<{ rows: unknown[] }> } }) => (await o.db.executeSql('select 1')).rows) as never);
    expect(await new PgBossJobQueue(boss).enqueue('n', {}, { singletonKey: 'k' }, { query: query as never })).toBe('mine');
    expect(query).toHaveBeenCalledWith('select 1', undefined);
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

  describe('schedule: a chain of sends, no pg-boss cron', () => {
    const at = (iso: string) => () => new Date(iso);
    const held = (iso: string, state = 'created', id = 'held') => ({ id, state, startAfter: new Date(iso) });
    const sent = (boss: ReturnType<typeof stub>) => boss.send.mock.calls.map((c) => c as unknown as [string, unknown, { singletonKey: string; startAfter: Date }]);

    it('sends the first run with a key of its own and the next UTC time as its start, a null payload by default, and never uses the library schedule', async () => {
      const boss = stub();
      const q = new PgBossJobQueue(boss, undefined, at('2026-03-10T10:07:30Z'));
      await q.schedule('n', '*/5 * * * *');
      await q.schedule('m', '0 3 * * *', { x: 1 });
      expect(sent(boss)).toEqual([
        ['n', null, { singletonKey: 'sched:n', startAfter: new Date('2026-03-10T10:10:00Z') }],
        ['m', { x: 1 }, { singletonKey: 'sched:m', startAfter: new Date('2026-03-11T03:00:00Z') }],
      ]);
      expect(boss.schedule).not.toHaveBeenCalled();
      expect(boss.findJobs).toHaveBeenCalledWith('n', { key: 'sched:n', queued: true, limit: 10 });
    });

    it('leaves a waiting run alone when its time is one of the cron, even a late one, so a restart after downtime runs it once', async () => {
      const boss = stub();
      boss.findJobs.mockResolvedValue([held('2026-03-10T10:00:00Z')]);
      await new PgBossJobQueue(boss, undefined, at('2026-03-10T10:12:00Z')).schedule('n', '*/5 * * * *');
      expect(boss.send).not.toHaveBeenCalled();
      expect(boss.cancel).not.toHaveBeenCalled();
    });

    it('cancels a waiting run whose time is not one of the current cron and sends the right one', async () => {
      const boss = stub();
      boss.findJobs.mockResolvedValue([held('2026-03-10T10:05:00Z')]);
      await new PgBossJobQueue(boss, undefined, at('2026-03-10T10:02:00Z')).schedule('n', '0 * * * *');
      expect(boss.cancel).toHaveBeenCalledWith('n', 'held');
      expect(sent(boss)).toEqual([['n', null, { singletonKey: 'sched:n', startAfter: new Date('2026-03-10T11:00:00Z') }]]);
    });

    it('refuses a cron it cannot read, and then sends nothing and runs no next', async () => {
      const boss = stub();
      const q = new PgBossJobQueue(boss, undefined, at('2026-03-10T10:00:00Z'));
      await expect(q.schedule('n', 'every day')).rejects.toThrow();
      await q.work('n', async () => {});
      await (boss.work.mock.calls[0]?.[2] as unknown as (jobs: unknown[]) => Promise<void>)([{ id: 'j', data: {}, retryCount: 0, retryLimit: 0, expireInSeconds: 60 }]);
      expect(boss.send).not.toHaveBeenCalled();
    });

    it('sends the next run before the handler starts, from the time it is now, so a failing run keeps the chain and a late one skips what it missed', async () => {
      const boss = stub();
      const order: string[] = [];
      boss.send.mockImplementation((async () => { order.push('send'); return 'id'; }) as never);
      const q = new PgBossJobQueue(boss, undefined, at('2026-03-10T10:12:00Z'));
      await q.schedule('n', '*/5 * * * *', { p: 1 });
      boss.send.mockClear();
      order.length = 0;
      await q.work('n', async () => { order.push('handler'); throw new Error('fails'); });
      const run = boss.work.mock.calls[0]?.[2] as unknown as (jobs: unknown[]) => Promise<void>;
      await expect(run([{ id: 'j', data: { p: 1 }, retryCount: 0, retryLimit: 0, expireInSeconds: 900 }])).rejects.toThrow('fails');
      expect(order).toEqual(['send', 'handler']);
      expect(sent(boss)).toEqual([['n', { p: 1 }, { singletonKey: 'sched:n', startAfter: new Date('2026-03-10T10:15:00Z') }]]);
    });

    const runOne = (boss: ReturnType<typeof stub>, startAfter?: Date) =>
      (boss.work.mock.calls[0]?.[2] as unknown as (jobs: unknown[]) => Promise<void>)([{ id: 'j', data: {}, retryCount: 0, retryLimit: 0, expireInSeconds: 60, ...(startAfter ? { startAfter } : {}) }]);

    it('runs the handler even when the next run cannot be sent, then sends it again, so a failed send on the last attempt does not end the schedule', async () => {
      const boss = stub();
      const q = new PgBossJobQueue(boss, undefined, at('2026-03-10T10:00:00Z'));
      await q.schedule('n', '*/5 * * * *');
      boss.send.mockClear();
      boss.send.mockRejectedValueOnce(new Error('db down'));
      const handler = vi.fn(async () => {});
      await q.work('n', handler);
      await runOne(boss);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(boss.send).toHaveBeenCalledTimes(2);
    });

    it('fails the run, after the handler, when the next run cannot be sent twice (pg-boss retries it, and a retry sends again)', async () => {
      const boss = stub();
      const q = new PgBossJobQueue(boss, undefined, at('2026-03-10T10:00:00Z'));
      await q.schedule('n', '*/5 * * * *');
      boss.send.mockClear();
      boss.send.mockRejectedValue(new Error('db down'));
      const handler = vi.fn(async () => {});
      await q.work('n', handler);
      await expect(runOne(boss)).rejects.toThrow('db down');
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('lets the handler error win over a send that failed, and tries the send once more', async () => {
      const boss = stub();
      const q = new PgBossJobQueue(boss, undefined, at('2026-03-10T10:00:00Z'));
      await q.schedule('n', '*/5 * * * *');
      boss.send.mockClear();
      boss.send.mockRejectedValue(new Error('db down'));
      await q.work('n', async () => { throw new Error('handler failed'); });
      await expect(runOne(boss)).rejects.toThrow('handler failed');
      expect(boss.send).toHaveBeenCalledTimes(2);
    });

    it('computes the successor from no earlier than the start of the run it follows, so a clock that runs behind does not send the same time again', async () => {
      const boss = stub();
      const q = new PgBossJobQueue(boss, undefined, at('2026-03-10T10:12:30Z'));
      await q.schedule('n', '*/5 * * * *');
      boss.send.mockClear();
      await q.work('n', async () => {});
      await runOne(boss, new Date('2026-03-10T10:15:00Z'));
      expect(sent(boss)).toEqual([['n', null, { singletonKey: 'sched:n', startAfter: new Date('2026-03-10T10:20:00Z') }]]);
    });

    it('looks only at the waiting run (created), never at a retry of a failed one, which has a start time that is no time of the cron', async () => {
      const boss = stub();
      boss.findJobs.mockResolvedValue([held('2026-03-10T10:02:17Z', 'retry', 'retrying'), held('2026-03-10T10:05:00Z')]);
      await new PgBossJobQueue(boss, undefined, at('2026-03-10T10:02:00Z')).schedule('n', '*/5 * * * *');
      expect(boss.cancel).not.toHaveBeenCalled();
      expect(boss.send).not.toHaveBeenCalled();
      boss.findJobs.mockResolvedValue([held('2026-03-10T10:02:17Z', 'retry', 'retrying')]);
      await new PgBossJobQueue(boss, undefined, at('2026-03-10T10:02:00Z')).schedule('n', '*/5 * * * *');
      expect(boss.cancel).not.toHaveBeenCalled();
      expect(sent(boss)).toHaveLength(1); // no waiting run: the first is sent
    });

    it('replaces a waiting run that is later than the next time of the cron (a daily run kept after the cron became every minute)', async () => {
      const boss = stub();
      boss.findJobs.mockResolvedValue([held('2026-03-11T03:00:00Z')]);
      await new PgBossJobQueue(boss, undefined, at('2026-03-10T10:00:00Z')).schedule('n', '* * * * *');
      expect(boss.cancel).toHaveBeenCalledWith('n', 'held');
      expect(sent(boss)).toEqual([['n', null, { singletonKey: 'sched:n', startAfter: new Date('2026-03-10T10:01:00Z') }]]);
    });

    it('sends no next run for a queue that has no schedule', async () => {
      const boss = stub();
      const q = new PgBossJobQueue(boss, undefined, at('2026-03-10T10:00:00Z'));
      await q.work('plain', async () => {});
      await (boss.work.mock.calls[0]?.[2] as unknown as (jobs: unknown[]) => Promise<void>)([{ id: 'j', data: {}, retryCount: 0, retryLimit: 0, expireInSeconds: 60 }]);
      expect(boss.send).not.toHaveBeenCalled();
    });
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

  it('isLive asks whether a job with the key is queued, waiting for a retry or running', async () => {
    const boss = stub();
    const executeSql = vi.fn<(...args: unknown[]) => Promise<{ rows: unknown[] }>>(async () => ({ rows: [] }));
    boss.getDb.mockReturnValue({ executeSql } as never);
    const q = new PgBossJobQueue(boss);
    expect(await q.isLive('n', 'k')).toBe(false);
    executeSql.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    expect(await q.isLive('n', 'k')).toBe(true);
    expect(executeSql).toHaveBeenCalledWith(expect.stringMatching(/from pgboss\.job where name = \$1 and singleton_key = \$2 and state <= 'active' limit 1/), ['n', 'k']);
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

describe('PgBossJobQueue, the real clock', () => {
  it('sends the first run of an every-minute schedule at the next whole minute', async () => {
    const boss = stub();
    const before = Date.now();
    await new PgBossJobQueue(boss).schedule('n', '* * * * *');
    const start = ((boss.send.mock.calls[0] as unknown as unknown[])[2] as { startAfter: Date }).startAfter.getTime();
    expect(start).toBeGreaterThan(before);
    expect(start - before).toBeLessThanOrEqual(60_000);
    expect(start % 60_000).toBe(0);
  });
});
