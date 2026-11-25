import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../src/testing/fake-clock.js';
import { FakeIdempotencyStore } from '../../src/testing/fake-idempotency-store.js';

const H1 = 'aa';
const H2 = 'bb';
const done = { status: 201, body: { id: 'x' } };

describe('FakeIdempotencyStore', () => {
  it('claims once, refuses a second claim while the first runs, and replays after complete', async () => {
    const store = new FakeIdempotencyStore();
    expect(await store.claim('legacy', 'u', 'k', H1)).toEqual({ kind: 'claimed' });
    expect(await store.claim('legacy', 'u', 'k', H1)).toEqual({ kind: 'conflict' });
    await store.complete('legacy', 'u', 'k', done);
    expect(await store.claim('legacy', 'u', 'k', H1)).toEqual({ kind: 'replay', response: done });
    expect(await store.claim('legacy', 'u', 'k', H2)).toEqual({ kind: 'conflict' });
  });

  it('keeps users and keys apart, even when they contain the separator', async () => {
    const store = new FakeIdempotencyStore();
    expect((await store.claim('legacy', 'u', 'a:b', H1)).kind).toBe('claimed');
    expect((await store.claim('legacy', 'u:a', 'b', H1)).kind).toBe('claimed');
    expect((await store.claim('legacy', 'v', 'a:b', H1)).kind).toBe('claimed');
    expect(store.size).toBe(3);
  });

  it('release frees a running claim but never removes a finished answer; completing an unknown key does nothing', async () => {
    const store = new FakeIdempotencyStore();
    await store.claim('legacy', 'u', 'k', H1);
    await store.release('legacy', 'u', 'k');
    expect(await store.claim('legacy', 'u', 'k', H2)).toEqual({ kind: 'claimed' });
    await store.complete('legacy', 'u', 'k', done);
    await store.release('legacy', 'u', 'k');
    expect((await store.claim('legacy', 'u', 'k', H2)).kind).toBe('replay');
    await store.complete('legacy', 'u', 'missing', done);
    expect(store.size).toBe(1);
  });

  it('deletes only the rows created before the cutoff, by the injected clock', async () => {
    const clock = new FakeClock(1000);
    const store = new FakeIdempotencyStore(clock);
    await store.claim('legacy', 'u', 'old', H1);
    clock.advance(500);
    await store.claim('legacy', 'u', 'new', H1);
    expect(await store.deleteCreatedBefore(1400)).toBe(1);
    expect(await store.deleteCreatedBefore(1400)).toBe(0);
    expect(store.size).toBe(1);
    expect((await store.claim('legacy', 'u', 'old', H1)).kind).toBe('claimed');
  });

  it('uses the system clock by default', async () => {
    const store = new FakeIdempotencyStore();
    await store.claim('legacy', 'u', 'k', H1);
    expect(await store.deleteCreatedBefore(Date.now() + 1000)).toBe(1);
  });
});
