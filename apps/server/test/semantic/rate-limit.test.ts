import { describe, expect, it } from 'vitest';
import { createRateLimiter } from '../../src/jobs/rate-limit.js';

describe('the rate limiter', () => {
  function limiter(perMinute: number, capacity?: number) {
    let now = 0;
    const slept: number[] = [];
    const l = createRateLimiter({ perMinute, ...(capacity === undefined ? {} : { capacity }), now: () => now, sleep: (ms) => { slept.push(ms); now += ms; return Promise.resolve(); } });
    return { l, slept, at: () => now, wait: (ms: number) => { now += ms; } };
  }
  const signal = new AbortController().signal;

  it('starts empty and lets a batch through when enough has accrued: 16 chunks at 60 a minute wait 16 s', async () => {
    const { l, slept, at } = limiter(60);
    await l.acquire(16, signal);
    expect(slept).toEqual([16_000]);
    expect(at()).toBe(16_000);
  });

  it('refills while idle up to its capacity, so a quiet time is not paid for twice and a long one does not store up a burst', async () => {
    const { l, slept, wait } = limiter(60, 16);
    wait(10 * 60_000); // ten idle minutes: the bucket is full, not at 600
    await l.acquire(16, signal);
    expect(slept).toEqual([]);
    await l.acquire(16, signal);
    expect(slept).toEqual([16_000]);
  });

  it('lets a request larger than the capacity through once the capacity is there', async () => {
    const { l, slept } = limiter(60, 4);
    await l.acquire(10, signal);
    expect(slept.reduce((a, b) => a + b, 0)).toBe(10_000);
  });

  it('stops waiting when the signal aborts', async () => {
    const stop = new AbortController();
    stop.abort();
    const l = createRateLimiter({ perMinute: 1, now: () => 0, sleep: (_ms, s) => (s.aborted ? Promise.reject(new Error('aborted')) : Promise.resolve()) });
    await expect(l.acquire(5, stop.signal)).rejects.toThrow('aborted');
  });
});
