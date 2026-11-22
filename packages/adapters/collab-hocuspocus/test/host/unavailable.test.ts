import { afterEach, describe, expect, it } from 'vitest';
import { makeFakeConfig } from '@tektum/grimoire-core/testing/fake-config';
import { PAGE } from './support.js';
import { connect, eventually, startLive } from './live-support.js';
import type { Client, Live } from './live-support.js';

// R4.9: an unavailable verifier or database is not a bad token. The client is told `try-again`, nobody is let in, open connections
// stay open, and the address is not charged a failed attempt (so an outage cannot get honest users banned by the attempt limit).
const ATTEMPTS = 3;
const lives: Live[] = [];
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.destroy();
  for (const l of lives.splice(0)) await l.stop();
});

async function live(): Promise<Live> {
  const l = await startLive('member', {}, (t) => {
    t.deps = { ...t.deps, config: makeFakeConfig({ collab: { connectAttemptsPerWindow: ATTEMPTS } }) };
  });
  l.t.pages.seed(PAGE);
  lives.push(l);
  return l;
}

/** One connection attempt that is refused: waits for the refusal and for the socket to close (the guard charges at close). */
async function refusedOnce(l: Live): Promise<string[]> {
  const c = connect(l, PAGE, 't', { maxAttempts: 1 }); clients.push(c);
  await eventually(() => c.closes.length > 0, 5000, 'socket closed');
  c.destroy();
  return c.failures;
}
const rateRefusals = (l: Live) => l.t.logger.entries.filter((e) => e.event === 'collab.upgrade_refused');

describe('unavailable is not invalid (R4.9)', () => {
  it.each(['verifier', 'database'] as const)('%s down: more try-again refusals than the attempt limit, no ban; open connections stay open; recovery admits', async (what) => {
    const l = await live();
    const open = connect(l, PAGE, 't'); clients.push(open);
    await eventually(() => open.provider.synced, 5000, 'open connection synced');
    if (what === 'verifier') l.t.verifier.result = { kind: 'service-unavailable' };
    else l.t.resolve.fail = new Error('db down');
    for (let i = 0; i < ATTEMPTS + 2; i++) expect(await refusedOnce(l)).toEqual(['try-again']);
    expect(l.t.logger.entries.filter((e) => e.event === 'collab.auth_unavailable').length).toBeGreaterThanOrEqual(1);
    expect(rateRefusals(l)).toEqual([]);
    expect(open.provider.isAuthenticated).toBe(true);
    expect(open.provider.configuration.websocketProvider.status).toBe('connected');
    expect(open.closes).toEqual([]);

    if (what === 'verifier') l.t.verifier.result = { kind: 'ok', userId: 'u1', expiresAt: 10_000_000 };
    else l.t.resolve.fail = undefined;
    const next = connect(l, PAGE, 't'); clients.push(next);
    await eventually(() => next.provider.synced, 5000, 'admitted after recovery');
  }, 30_000);

  it('control: the same number of invalid tokens does get the address limited (the test can see a ban)', async () => {
    const l = await live();
    l.t.verifier.result = { kind: 'invalid-token' };
    for (let i = 0; i < ATTEMPTS; i++) expect(await refusedOnce(l)).toEqual(['invalid-token']);
    const c = connect(l, PAGE, 't', { maxAttempts: 1 }); clients.push(c);
    await eventually(() => rateRefusals(l).length > 0, 5000, 'rate refusal');
    expect(rateRefusals(l)[0]?.fields).toMatchObject({ reason: 'rate', status: 429 });
  }, 30_000);
});
