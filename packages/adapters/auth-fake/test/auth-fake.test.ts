import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../../core/src/testing/fake-clock.js';
import { FakeAuthVerifier } from '../src/index.js';

describe('FakeAuthVerifier', () => {
  it('ok', async () => {
    const f = new FakeAuthVerifier(new FakeClock(0)).allow('t', 'u1', 500);
    expect(await f.verify('t')).toEqual({ kind: 'ok', userId: 'u1', expiresAt: 500 });
  });
  it('ok with expiresAt in the past is returned verbatim', async () => {
    const f = new FakeAuthVerifier(new FakeClock(1000)).allow('t', 'u1', 10);
    expect(await f.verify('t')).toEqual({ kind: 'ok', userId: 'u1', expiresAt: 10 });
  });
  it.each([
    { kind: 'ok', profile: { email: 'alice@example.test', name: 'Alice', emailVerified: true } },
    { kind: 'unavailable' },
    { kind: 'not-configured' },
  ] as const)('scripts profile result $kind', async (result) => {
    const f = new FakeAuthVerifier(new FakeClock(0)).profileFor('alice', result);
    expect(await f.profile('alice')).toEqual(result);
  });

  it('invalid-token for rejected and unscripted tokens', async () => {
    const f = new FakeAuthVerifier(new FakeClock(0)).reject('bad');
    expect(await f.verify('bad')).toEqual({ kind: 'invalid-token' });
    expect(await f.verify('unknown')).toEqual({ kind: 'invalid-token' });
  });
  it('service-unavailable is distinct, per token and global, and recovers', async () => {
    const f = new FakeAuthVerifier(new FakeClock(0)).allow('t', 'u').unavailable('x');
    expect(await f.verify('x')).toEqual({ kind: 'service-unavailable' });
    expect(await f.verify('t')).toMatchObject({ kind: 'ok' });
    f.unavailable();
    expect(await f.verify('t')).toEqual({ kind: 'service-unavailable' });
    f.recover();
    expect(await f.verify('t')).toMatchObject({ kind: 'ok' });
  });
  it('clock-driven expiry: valid just before, invalid at and after', async () => {
    const c = new FakeClock(0);
    const f = new FakeAuthVerifier(c).allowUntil('t', 'u', 100);
    c.set(99);
    expect((await f.verify('t')).kind).toBe('ok');
    c.set(100);
    expect((await f.verify('t')).kind).toBe('invalid-token');
    c.set(101);
    expect((await f.verify('t')).kind).toBe('invalid-token');
  });
});
