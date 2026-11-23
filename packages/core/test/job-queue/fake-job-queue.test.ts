import { describe, expect, it } from 'vitest';
import { FakeDatabase } from '../../src/testing/fake-database.js';
import { FakeJobQueue } from '../../src/testing/fake-job-queue.js';

describe('FakeJobQueue extras', () => {
  it('runs nothing before the clock moves and records job states', async () => {
    const q = new FakeJobQueue();
    await q.work('a', async () => {});
    await q.enqueue('a', 1);
    expect(q.all).toEqual([{ id: 'job-1', name: 'a', state: 'queued', attempt: 0 }]);
    await q.advance(0);
    expect(q.all[0]?.state).toBe('done');
  });

  it('marks a job failed once retries are used up', async () => {
    const q = new FakeJobQueue();
    await q.work('a', async () => { throw new Error('x'); });
    await q.enqueue('a', 1, { retryLimit: 1 });
    await q.advance(0);
    expect(q.all[0]).toMatchObject({ state: 'failed', attempt: 2 });
  });

  it('accepts a singleton key again once the first job is done', async () => {
    const q = new FakeJobQueue();
    await q.work('a', async () => {});
    await q.enqueue('a', 1, { singletonKey: 'k' });
    await q.advance(0);
    expect(await q.enqueue('a', 1, { singletonKey: 'k' })).toBe('job-2');
  });

  it('fires "*/2 * * * *" every second minute and rejects other cron forms', async () => {
    const q = new FakeJobQueue();
    let runs = 0;
    await q.work('s', async () => { runs++; });
    await q.schedule('s', '*/2 * * * *');
    await q.advance(300);
    expect(runs).toBe(2);
    await expect(q.schedule('s', '0 3 * * *')).rejects.toThrow(/understands only/);
    await expect(q.schedule('s', '*/0 * * * *')).rejects.toThrow(/at least 1/);
  });

  it('keeps a job queued while no handler is registered', async () => {
    const q = new FakeJobQueue();
    await q.enqueue('late', 1);
    await q.advance(5);
    expect(q.all[0]?.state).toBe('queued');
    let ran = false;
    await q.work('late', async () => { ran = true; });
    await q.advance(0);
    expect(ran).toBe(true);
  });

  it('refuses a transactional enqueue when it has no database to read commits from', async () => {
    const q = new FakeJobQueue();
    await expect(q.enqueue('a', 1, {}, new FakeDatabase())).rejects.toThrow(/needs the committed database/);
  });

  it('gives transactional enqueues unique ids and null for a duplicate singleton', async () => {
    const db = new FakeDatabase();
    const q = new FakeJobQueue(db);
    const ids = await db.transaction(async (tx) => [
      await q.enqueue('a', 1, {}, tx),
      await q.enqueue('a', 2, {}, tx),
      await q.enqueue('a', 3, { singletonKey: 'k' }, tx),
      await q.enqueue('a', 4, { singletonKey: 'k' }, tx),
    ]);
    expect(ids[3]).toBeNull();
    expect(new Set(ids.slice(0, 3)).size).toBe(3);
    const seen: number[] = [];
    await q.work<number>('a', async (p) => { seen.push(p); });
    await q.advance(0);
    expect(seen).toEqual([1, 2, 3]);
    expect(q.all.map((j) => j.id)).toEqual(ids.slice(0, 3));
  });

  it('counts the delay of a committed transactional job from the enqueue, not from the end of the advance', async () => {
    const db = new FakeDatabase();
    const q = new FakeJobQueue(db);
    let runs = 0;
    await q.work('a', async () => { runs++; });
    await db.transaction(async (tx) => { await q.enqueue('a', 1, { delaySeconds: 5 }, tx); });
    await q.advance(10);
    expect(runs).toBe(1);
  });
});
