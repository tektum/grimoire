import { describe, expect, it } from 'vitest';
import { createHandshakeToken, MAX_HANDSHAKE_LENGTH, TOKEN_WAIT_MS, TokenUnavailable } from '../../src/editor/core/handshake-token';
import { decodeHandshake, FakeClock, flush, harness } from './support';

const make = (over: { token?: string | null; epoch?: () => number | null; getToken?: () => Promise<string | null>; clock?: FakeClock } = {}) => {
  const clock = over.clock ?? new FakeClock();
  return {
    clock,
    fn: createHandshakeToken({
      getToken: over.getToken ?? (async () => (over.token === undefined ? 'session-token' : over.token)),
      clientVersion: '1.2.3',
      epoch: over.epoch ?? (() => null),
      timers: clock,
    }),
  };
};

describe('the handshake token', () => {
  it("encodes like the platform's own base64url, for text with characters outside ASCII and for every padding length", async () => {
    for (const token of ['x', 'xy', 'xyz', 'ünï-cødé-τοκεν-日本語-🙂', '???>>>~~~']) {
      const made = await make({ token }).fn();
      const json = JSON.stringify({ t: token, v: '1.2.3' });
      expect(made.slice(3)).toBe(Buffer.from(json, 'utf8').toString('base64url'));
    }
  });

  it('is g1. and the base64url of {t, v} on a first connect, with no padding and no e', async () => {
    const token = await make().fn();
    expect(token.startsWith('g1.')).toBe(true);
    expect(token.slice(3)).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeHandshake(token)).toEqual({ t: 'session-token', v: '1.2.3' });
    expect(Object.keys(decodeHandshake(token))).not.toContain('e');
  });

  it('carries {t, v, e} once an epoch was recorded, and decodes back to the same object', async () => {
    const token = await make({ epoch: () => 7 }).fn();
    expect(decodeHandshake(token)).toEqual({ t: 'session-token', v: '1.2.3', e: 7 });
    expect(await make({ epoch: () => 0 }).fn()).toContain('g1.'); // epoch 0 is an epoch: e is sent
    expect(decodeHandshake(await make({ epoch: () => 0 }).fn()).e).toBe(0);
  });

  it('never exceeds 8,192 characters for a 6,000-character session token, and refuses a token that would', async () => {
    const six = await make({ token: 'a'.repeat(6000), epoch: () => 2147483647 }).fn();
    expect(six.length).toBeLessThanOrEqual(MAX_HANDSHAKE_LENGTH);
    expect(MAX_HANDSHAKE_LENGTH).toBe(8192);
    await expect(make({ token: 'a'.repeat(7000) }).fn()).rejects.toThrow(TokenUnavailable);
  });

  it('is asked again on each automatic reconnect, and the epoch it carries follows the one recorded', async () => {
    let recorded: number | null = null;
    const { fn } = make({ epoch: () => recorded });
    const seen: (number | undefined)[] = [];
    seen.push(decodeHandshake(await fn()).e); // the first connect
    recorded = 4; // the page synced and the epoch was recorded
    for (const next of [4, 5, 5]) {
      if (next !== recorded) recorded = next; // a later sync recorded a newer one
      seen.push(decodeHandshake(await fn()).e); // three scripted automatic reconnects
    }
    expect(seen).toEqual([undefined, 4, 5, 5]);
  });

  it('carries the version of the client on every connect', async () => {
    const h = harness();
    const fn = createHandshakeToken({ getToken: async () => 'x', clientVersion: h.options.clientVersion, epoch: () => null, timers: h.clock });
    for (let i = 0; i < 3; i++) expect(decodeHandshake(await fn()).v).toBe('0.0.0');
  });

  it('fails, not waits, when the session token takes longer than two seconds (an unauthenticated socket must not stay open)', async () => {
    const clock = new FakeClock();
    const { fn } = make({ clock, getToken: () => new Promise(() => {}) });
    const outcome = fn().then(
      () => 'token',
      (e: Error) => e,
    );
    await clock.advance(TOKEN_WAIT_MS - 1);
    let settled = false;
    void outcome.then(() => (settled = true));
    await flush();
    expect(settled).toBe(false);
    await clock.advance(1);
    expect(await outcome).toBeInstanceOf(TokenUnavailable);
    expect(clock.pendingCount()).toBe(0); // no timer left behind
  });

  it('fails when signed out, or when the session read throws, and does not leave a timer behind on success', async () => {
    await expect(make({ token: null }).fn()).rejects.toThrow('signed out');
    await expect(make({ token: '' }).fn()).rejects.toThrow(TokenUnavailable);
    await expect(make({ getToken: async () => Promise.reject(new Error('boom')) }).fn()).rejects.toThrow(TokenUnavailable);
    const ok = make();
    await ok.fn();
    expect(ok.clock.pendingCount()).toBe(0);
  });
});
