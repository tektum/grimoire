import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CollabLog } from '../../src/events.js';
import {
  addressKey, buildTrustedProxies, canonicalOrigin, createUpgradeGuard, normaliseAddress, originAllowed, resolveClientAddress,
} from '../../src/upgrade-guard.js';

const allowed = new Set(['https://good.example', 'http://localhost:5173']);
const trusted = buildTrustedProxies(['10.0.0.0/8', '192.168.1.1', '::1', 'fd00::/8']);

describe('client address', () => {
  it('uses the peer address when it is not a trusted proxy, ignoring any forwarding header', () => {
    expect(resolveClientAddress(null, '203.0.113.9', trusted)).toBe('203.0.113.9');
    expect(resolveClientAddress('1.2.3.4', '203.0.113.9', trusted)).toBe('203.0.113.9'); // forged by an untrusted peer
    expect(resolveClientAddress('1.2.3.4', '203.0.113.9', buildTrustedProxies([]))).toBe('203.0.113.9');
  });
  it('reads the right-most entry that is not a trusted proxy when the peer is trusted', () => {
    expect(resolveClientAddress('198.51.100.7', '10.1.2.3', trusted)).toBe('198.51.100.7');
    expect(resolveClientAddress('6.6.6.6, 198.51.100.7', '10.1.2.3', trusted)).toBe('198.51.100.7'); // left-most is client-supplied
    expect(resolveClientAddress('198.51.100.7, 10.9.9.9, 192.168.1.1', '10.1.2.3', trusted)).toBe('198.51.100.7');
    expect(resolveClientAddress('2001:db8::1', '::1', trusted)).toBe('2001:db8::1');
  });
  it('keeps the peer when the header is malformed or has only trusted entries', () => {
    expect(resolveClientAddress('not-an-ip', '10.1.2.3', trusted)).toBe('10.1.2.3');
    expect(resolveClientAddress('198.51.100.7, garbage', '10.1.2.3', trusted)).toBe('10.1.2.3');
    expect(resolveClientAddress('', '10.1.2.3', trusted)).toBe('10.1.2.3');
    expect(resolveClientAddress('10.5.5.5, 10.6.6.6', '10.1.2.3', trusted)).toBe('10.5.5.5');
  });
  it('treats IPv4-mapped IPv6 as the IPv4 address, in the peer, the header and the proxy list', () => {
    expect(normaliseAddress('::ffff:1.2.3.4')).toBe('1.2.3.4');
    expect(normaliseAddress('::FFFF:102:304')).toBe('1.2.3.4');
    expect(resolveClientAddress(null, '::ffff:203.0.113.9', trusted)).toBe('203.0.113.9');
    expect(resolveClientAddress('::ffff:198.51.100.7', '::ffff:10.1.2.3', trusted)).toBe('198.51.100.7');
    expect(normaliseAddress('2001:DB8:0:0::1')).toBe('2001:db8::1');
    expect(normaliseAddress('fe80::1%eth0')).toBe('fe80::1');
    expect(normaliseAddress('nonsense')).toBeUndefined();
    expect(resolveClientAddress(null, undefined, trusted)).toBe('unknown');
  });
});

describe('origin comparison', () => {
  const ok = (...v: string[]): boolean => originAllowed(v, allowed);
  it('accepts exactly the configured origins', () => {
    expect(ok('https://good.example')).toBe(true);
    expect(ok('http://localhost:5173')).toBe(true);
    expect(ok('HTTPS://GOOD.EXAMPLE')).toBe(true); // scheme and host are case-insensitive in the URL standard
    expect(ok('https://good.example:443')).toBe(true); // default port is the same origin
  });
  it('refuses everything else', () => {
    expect(ok()).toBe(false); // no header
    expect(ok('https://good.example:8443')).toBe(false); // other port
    expect(ok('http://good.example')).toBe(false); // other scheme
    expect(ok('http://localhost:5174')).toBe(false);
    expect(ok('http://localhost')).toBe(false);
    expect(ok('https://good.example/')).toBe(false); // trailing slash
    expect(ok('https://good.example.')).toBe(false); // trailing dot
    expect(ok('https://good.example/path')).toBe(false);
    expect(ok('https://good.example.evil.test')).toBe(false); // suffix lookalike
    expect(ok('https://evil-good.example')).toBe(false);
    expect(ok('https://good.example@evil.test')).toBe(false);
    expect(ok('https://evil.test#https://good.example')).toBe(false);
    expect(ok('null')).toBe(false);
    expect(ok('')).toBe(false);
    expect(ok('*')).toBe(false);
    expect(ok('https://good.example', 'https://good.example')).toBe(false); // several Origin headers
    expect(ok('https://good.example', 'https://evil.test')).toBe(false);
  });
  it('canonicalises like the URL standard', () => {
    expect(canonicalOrigin('HTTPS://Good.Example')).toBe('https://good.example');
    expect(canonicalOrigin('https://good.example/')).toBeUndefined();
  });
});

function fakeLog(): { log: CollabLog; events: { event: string; fields: unknown }[] } {
  const events: { event: string; fields: unknown }[] = [];
  return { log: { emit: (event, fields) => { events.push({ event, fields }); } }, events };
}
function request(peer: string, headers: Record<string, string> = { Origin: 'https://good.example' }): { req: IncomingMessage; socket: Duplex & EventEmitter } {
  const socket = Object.assign(new EventEmitter(), { remoteAddress: peer }) as unknown as Duplex & EventEmitter; // a stand-in with the two members the guard reads
  const rawHeaders = Object.entries(headers).flat();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { req: { socket, rawHeaders, headers: lower } as unknown as IncomingMessage, socket };
}
const make = (over: Partial<Parameters<typeof createUpgradeGuard>[0] & object> = {}) => {
  const l = fakeLog();
  const guard = createUpgradeGuard({
    allowedOrigins: ['https://good.example'], trustedProxies: [], attemptsPerWindow: 50, windowSeconds: 60, banSeconds: 300,
    maxUnauthSocketsPerAddress: 10, maxUnauthSockets: 500, maxUnauthQueuedBytes: 64 * 1024 * 1024, log: l.log, ...over,
  });
  return { guard, ...l };
};

type Guard = ReturnType<typeof make>['guard'];
let seq = 0;
/** An accepted upgrade that then ends without authenticating (or authenticates first). */
async function attempt(guard: Guard, peer: string, end: 'fail' | 'authenticate' | 'stay', headers?: Record<string, string>) {
  const r = request(peer, headers);
  const v = await guard.checkUpgrade(r.req, r.socket);
  if (!v.ok) return v;
  const id = `p${String(seq++)}`;
  guard.onOpen(id, v.address, v.ticket);
  if (end === 'authenticate') { guard.onAuthenticated(id); r.socket.emit('close'); }
  if (end === 'fail') r.socket.emit('close');
  await vi.advanceTimersByTimeAsync(0);
  return v;
}

describe('per-address attempts: only attempts that do not authenticate count (R4.19)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('50 failed attempts in 60 s are accepted, the 51st gets 429 with Retry-After, the ban lasts 300 s and other addresses are unaffected', async () => {
    const { guard, events } = make();
    for (let i = 0; i < 50; i += 1) expect((await attempt(guard, '203.0.113.1', 'fail')).ok).toBe(true);
    const refused = await attempt(guard, '203.0.113.1', 'fail');
    expect(refused).toMatchObject({ ok: false, status: 429 });
    expect(!refused.ok && refused.retryAfterSeconds).toBe(300);
    expect((await attempt(guard, '203.0.113.2', 'fail')).ok).toBe(true);
    await vi.advanceTimersByTimeAsync(299_000);
    const still = await attempt(guard, '203.0.113.1', 'fail');
    expect(!still.ok && still.retryAfterSeconds).toBeLessThanOrEqual(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await attempt(guard, '203.0.113.1', 'fail')).ok).toBe(true);
    expect(events.filter((e) => e.event === 'collab.upgrade_refused')).toEqual([{ event: 'collab.upgrade_refused', fields: { reason: 'rate', status: 429 } }]);
  });

  it('attempts that authenticate never count: 1,000 honest connections from one address are all accepted', async () => {
    const { guard } = make();
    for (let i = 0; i < 1000; i += 1) expect((await attempt(guard, '203.0.113.1', 'authenticate')).ok).toBe(true);
  });

  it('40 failures, then honest users: the honest ones still connect', async () => {
    const { guard } = make();
    for (let i = 0; i < 40; i += 1) await attempt(guard, '203.0.113.1', 'fail');
    for (let i = 0; i < 100; i += 1) expect((await attempt(guard, '203.0.113.1', 'authenticate')).ok).toBe(true);
  });

  it('a socket that never authenticates is destroyed after the timeout and counts as a failure', async () => {
    const { guard } = make({ unauthTimeoutMs: 1000 });
    const r = request('203.0.113.1');
    const destroyed = vi.fn();
    Object.assign(r.socket, { destroy: () => { destroyed(); r.socket.emit('close'); } });
    expect((await guard.checkUpgrade(r.req, r.socket)).ok).toBe(true);
    await vi.advanceTimersByTimeAsync(1001);
    expect(destroyed).toHaveBeenCalledOnce();
  });

  it('counts a forged X-Forwarded-For from an untrusted peer under the peer address', async () => {
    const { guard } = make({ maxUnauthSocketsPerAddress: 1000 });
    for (let i = 0; i < 50; i += 1) await attempt(guard, '203.0.113.1', 'fail', { Origin: 'https://good.example', 'X-Forwarded-For': `9.9.9.${String(i)}` });
    expect(await attempt(guard, '203.0.113.1', 'fail', { Origin: 'https://good.example', 'X-Forwarded-For': '9.9.9.200' })).toMatchObject({ ok: false, status: 429 });
  });

  it('counts two forwarded addresses separately behind a trusted proxy, and a forged value cannot frame another address', async () => {
    const { guard } = make({ trustedProxies: ['10.0.0.1'] });
    const via = (fwd: string) => attempt(guard, '10.0.0.1', 'fail', { Origin: 'https://good.example', 'X-Forwarded-For': fwd });
    for (let i = 0; i < 50; i += 1) await via('198.51.100.1');
    expect(await via('198.51.100.1')).toMatchObject({ ok: false, status: 429 });
    expect(await via('198.51.100.2')).toMatchObject({ ok: true, address: '198.51.100.2' });
    expect(await via('198.51.100.2, 198.51.100.1')).toMatchObject({ ok: false, status: 429 });
    expect(await via('198.51.100.1, 198.51.100.3')).toMatchObject({ ok: true, address: '198.51.100.3' });
  });

  it('refused origins are not counted: 500 bad-origin attempts, then an honest upgrade from the same address succeeds; a good-origin failure flood is still throttled', async () => {
    const { guard } = make();
    for (let i = 0; i < 500; i += 1) expect(await attempt(guard, '203.0.113.1', 'fail', { Origin: 'https://evil.example' })).toEqual({ ok: false, status: 403 });
    expect((await attempt(guard, '203.0.113.1', 'authenticate')).ok).toBe(true);
    for (let i = 0; i < 50; i += 1) await attempt(guard, '203.0.113.1', 'fail');
    expect(await attempt(guard, '203.0.113.1', 'fail')).toMatchObject({ ok: false, status: 429 });
  });

  it('a refusal by the unauthenticated-socket cap carries a short Retry-After and is not counted', async () => {
    const { guard } = make({ maxUnauthSocketsPerAddress: 1 });
    await attempt(guard, '203.0.113.1', 'stay');
    for (let i = 0; i < 200; i += 1) expect(await attempt(guard, '203.0.113.1', 'fail')).toEqual({ ok: false, status: 429, retryAfterSeconds: 2 });
  });
});

describe('origin refusal', () => {
  it('answers 403 for a wrong, a missing and a doubled Origin, logging one event without the value', async () => {
    const { guard, events } = make();
    expect(await guard.checkUpgrade(request('203.0.113.1', { Origin: 'https://evil.example' }).req, request('x').socket)).toEqual({ ok: false, status: 403 });
    expect(await guard.checkUpgrade(request('203.0.113.1', {}).req, request('x').socket)).toEqual({ ok: false, status: 403 });
    const doubled = request('203.0.113.1', {});
    Object.assign(doubled.req, { rawHeaders: ['Origin', 'https://good.example', 'origin', 'https://good.example'] });
    expect(await guard.checkUpgrade(doubled.req, doubled.socket)).toEqual({ ok: false, status: 403 });
    expect(events).toHaveLength(3);
    expect(JSON.stringify(events)).not.toContain('evil');
    expect(events[0]).toEqual({ event: 'collab.upgrade_refused', fields: { reason: 'origin', status: 403 } });
  });
});

/** Opens a socket through the guard the way the host does: upgrade, then `onOpen` with the ticket. */
async function open(guard: Guard, peer: string, id: string) {
  const r = request(peer);
  const v = await guard.checkUpgrade(r.req, r.socket);
  if (v.ok) guard.onOpen(id, v.address, v.ticket);
  return { v, socket: r.socket };
}

describe('unauthenticated sockets per address (R12.28)', () => {
  it('refuses the 11th with 429; one authenticating or closing frees a slot', async () => {
    const { guard } = make({ attemptsPerWindow: 1000 });
    const socks: (Duplex & EventEmitter)[] = [];
    for (let i = 0; i < 10; i += 1) {
      const { v, socket } = await open(guard, '203.0.113.1', `p${String(i)}`);
      expect(v.ok).toBe(true);
      socks.push(socket);
    }
    expect((await open(guard, '203.0.113.1', 'x')).v).toMatchObject({ ok: false, status: 429 });
    guard.onAuthenticated('p0');
    guard.onAuthenticated('p0'); // a second document on the same socket frees nothing more
    expect((await open(guard, '203.0.113.1', 'p10')).v.ok).toBe(true);
    expect((await open(guard, '203.0.113.1', 'y')).v).toMatchObject({ ok: false, status: 429 });
    guard.onClose('p1');
    expect((await open(guard, '203.0.113.1', 'p11')).v.ok).toBe(true);
    socks[2]?.emit('close'); // the TCP socket ending frees its slot too
    expect((await open(guard, '203.0.113.1', 'p12')).v.ok).toBe(true);
    expect((await open(guard, '203.0.113.2', 'z')).v.ok).toBe(true);
  });
});

describe('reservations belong to their socket (S2, S3)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('two sockets from one address authenticating in reverse order: neither is destroyed after 60 s and nothing is counted', async () => {
    const { guard } = make({ unauthTimeoutMs: 60_000, attemptsPerWindow: 1 }); // one charge would already ban the address
    const a = request('203.0.113.1'); const b = request('203.0.113.1');
    const destroyed: string[] = [];
    Object.assign(a.socket, { destroy: () => { destroyed.push('a'); a.socket.emit('close'); } });
    Object.assign(b.socket, { destroy: () => { destroyed.push('b'); b.socket.emit('close'); } });
    const va = await guard.checkUpgrade(a.req, a.socket); const vb = await guard.checkUpgrade(b.req, b.socket);
    if (!va.ok || !vb.ok) throw new Error('refused');
    guard.onOpen('pb', vb.address, vb.ticket); guard.onOpen('pa', va.address, va.ticket); // opened in the opposite order
    guard.onAuthenticated('pa'); guard.onAuthenticated('pb');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(destroyed).toEqual([]);
    a.socket.emit('close'); b.socket.emit('close');
    await vi.advanceTimersByTimeAsync(0);
    expect((await open(guard, '203.0.113.1', 'next')).v.ok).toBe(true); // nothing was charged against the address
  });

  it('with the sockets opened in the opposite order, only the one that never authenticates is destroyed after 60 s', async () => {
    const { guard } = make({ unauthTimeoutMs: 60_000 });
    const a = request('203.0.113.1'); const b = request('203.0.113.1');
    const destroyed: string[] = [];
    Object.assign(a.socket, { destroy: () => { destroyed.push('a'); a.socket.emit('close'); } });
    Object.assign(b.socket, { destroy: () => { destroyed.push('b'); b.socket.emit('close'); } });
    const va = await guard.checkUpgrade(a.req, a.socket); const vb = await guard.checkUpgrade(b.req, b.socket);
    if (!va.ok || !vb.ok) throw new Error('refused');
    guard.onOpen('pb', vb.address, vb.ticket); guard.onOpen('pa', va.address, va.ticket);
    guard.onAuthenticated('pa');
    await vi.advanceTimersByTimeAsync(61_000);
    expect(destroyed).toEqual(['b']);
  });

  it('a socket that closed during the awaited step leaves nothing reserved', async () => {
    const { guard } = make({ maxUnauthSocketsPerAddress: 1 });
    const r = request('203.0.113.1');
    const pending = guard.checkUpgrade(r.req, r.socket);
    r.socket.emit('close'); // before the limiter answers
    expect(await pending).toMatchObject({ ok: false });
    for (let i = 0; i < 5; i += 1) { // the single slot per address is still free every time
      const x = await open(guard, '203.0.113.1', `q${String(i)}`);
      expect(x.v.ok).toBe(true);
      x.socket.emit('close');
    }
  });

  it('random interleavings of open, authenticate, fail and close for 5 sockets on 2 addresses: counts return to zero and only failures are charged', async () => {
    let seed = 7;
    const rnd = (n: number): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n; };
    const LIMIT = 7;
    for (let round = 0; round < 100; round += 1) {
      const { guard } = make({ maxUnauthSocketsPerAddress: 5, attemptsPerWindow: LIMIT });
      const addrs = ['203.0.113.1', '203.0.113.2'];
      const failures = [0, 0];
      const socks = [];
      for (let i = 0; i < 5; i += 1) {
        const which = rnd(2);
        const end = rnd(2) === 0 ? 'authenticate' : 'fail';
        if (end === 'fail') failures[which] = (failures[which] ?? 0) + 1;
        const r = request(addrs[which] ?? '');
        const v = await guard.checkUpgrade(r.req, r.socket);
        if (!v.ok) throw new Error('refused');
        socks.push({ id: `s${String(i)}`, end, r, v });
      }
      const order = (): typeof socks => [...socks].sort(() => rnd(3) - 1);
      for (const x of order()) if (x.v.ok) guard.onOpen(x.id, x.v.address, x.v.ticket);
      for (const x of order()) {
        if (x.end === 'authenticate') guard.onAuthenticated(x.id);
        if (rnd(2) === 0) guard.onClose(x.id);
        x.r.socket.emit('close');
      }
      await vi.advanceTimersByTimeAsync(0);
      for (const [n, a] of addrs.entries()) {
        // exactly LIMIT - failures more failed attempts fit before the ban, and every slot is free again
        for (let k = 0; k < LIMIT - (failures[n] ?? 0); k += 1) {
          const x = await open(guard, a, `n${String(k)}`);
          expect(x.v.ok, `round ${String(round)} address ${a}`).toBe(true);
          x.socket.emit('close');
          await vi.advanceTimersByTimeAsync(0);
        }
        expect((await open(guard, a, 'over')).v, `round ${String(round)} address ${a}`).toMatchObject({ ok: false, status: 429 });
      }
    }
  });
});

describe('IPv6 addresses are keyed on their /64', () => {
  it('addressKey masks IPv6 to the /64 and leaves IPv4 alone', () => {
    expect(addressKey('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
    expect(addressKey('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(addressKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(addressKey('::1')).toBe('0:0:0:0::/64');
    expect(addressKey('203.0.113.1')).toBe('203.0.113.1');
    expect(addressKey('unknown')).toBe('unknown');
  });

  it('addresses inside one /64 share the unauthenticated cap and the ban; another /64 is unaffected', async () => {
    const { guard } = make({ maxUnauthSocketsPerAddress: 3 });
    for (let i = 0; i < 3; i += 1) expect((await open(guard, `2001:db8:1:2::${String(i + 1)}`, `p${String(i)}`)).v.ok).toBe(true);
    expect((await open(guard, '2001:db8:1:2:ffff::9', 'x')).v).toMatchObject({ ok: false, status: 429 });
    expect((await open(guard, '2001:db8:1:3::1', 'y')).v.ok).toBe(true);
  });

  it('50 failures spread over one /64 ban the whole /64', async () => {
    vi.useFakeTimers();
    try {
      const { guard } = make();
      for (let i = 0; i < 50; i += 1) { const x = await open(guard, `2001:db8:1:2::${i.toString(16)}`, `f${String(i)}`); x.socket.emit('close'); }
      await vi.advanceTimersByTimeAsync(0);
      expect((await open(guard, '2001:db8:1:2::dead', 'z')).v).toMatchObject({ ok: false, status: 429 });
    } finally { vi.useRealTimers(); }
  });
});

describe('global caps on unauthenticated sockets and queued bytes', () => {
  it('the 4th unauthenticated socket anywhere is refused with 503 while sockets that authenticate never count', async () => {
    const { guard } = make({ maxUnauthSockets: 3 });
    for (let i = 0; i < 3; i += 1) expect((await open(guard, `203.0.113.${String(i + 1)}`, `p${String(i)}`)).v.ok).toBe(true);
    expect((await open(guard, '203.0.113.9', 'x')).v).toMatchObject({ ok: false, status: 503, retryAfterSeconds: 5 });
    guard.onAuthenticated('p0');
    expect((await open(guard, '203.0.113.9', 'y')).v.ok).toBe(true);
  });

  it('an authenticated flood of honest users is never refused by the global caps', async () => {
    const { guard } = make({ maxUnauthSockets: 3, maxUnauthQueuedBytes: 1000 });
    for (let i = 0; i < 300; i += 1) {
      const { v } = await open(guard, `198.51.100.${String(i % 200)}`, `h${String(i)}`);
      expect(v.ok).toBe(true);
      expect(guard.onFrame(`h${String(i)}`, 100)).toBe(true);
      guard.onAuthenticated(`h${String(i)}`);
      expect(guard.onFrame(`h${String(i)}`, 10_000_000)).toBe(true); // frames after authentication are not queued bytes
    }
  });

  it('bytes sent before authentication count globally: past the cap new unauthenticated upgrades get 503 and the sender is told to close', async () => {
    const { guard } = make({ maxUnauthQueuedBytes: 1000 });
    expect((await open(guard, '203.0.113.1', 'a')).v.ok).toBe(true);
    expect(guard.onFrame('a', 600)).toBe(true);
    expect((await open(guard, '203.0.113.2', 'b')).v.ok).toBe(true);
    expect(guard.onFrame('b', 600)).toBe(false);
    expect((await open(guard, '203.0.113.3', 'c')).v).toMatchObject({ ok: false, status: 503 });
    guard.onClose('b'); // its bytes are released with it
    guard.onClose('a');
    expect((await open(guard, '203.0.113.3', 'c')).v.ok).toBe(true);
  });
});


describe('pre-sign-in window (U1)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  /** An upgraded socket as the guard sees it: it records what is written to it and a destroy ends it like the real one. */
  async function idle(guard: Guard, peer: string, peerId: string) {
    const r = request(peer);
    const written: Buffer[] = [];
    const destroyed = vi.fn();
    Object.assign(r.socket, { write: (b: Buffer, cb?: () => void) => { written.push(b); cb?.(); return true; }, destroy: () => { destroyed(); r.socket.emit('close'); } });
    const v = await guard.checkUpgrade(r.req, r.socket);
    if (v.ok) guard.onOpen(peerId, v.address, v.ticket);
    return { verdict: v, written, destroyed };
  }
  const addr = (i: number): string => `203.0.113.${String(i + 1)}`;

  it('10 sockets that never authenticate are all closed at 5 seconds with 4408 and a fixed reason, counted per address, and the 11th connects at once', async () => {
    const { guard, events } = make({ maxUnauthSockets: 10, attemptsPerWindow: 2, unauthTimeoutMs: 5000 });
    const held = await Promise.all(Array.from({ length: 10 }, (_, i) => idle(guard, addr(i), `p${String(i)}`)));
    expect(held.every((h) => h.verdict.ok)).toBe(true);
    expect((await attempt(guard, addr(20), 'stay')).ok).toBe(false); // global cap reached
    await vi.advanceTimersByTimeAsync(4999);
    for (const h of held) expect(h.destroyed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    for (const h of held) {
      expect(h.destroyed).toHaveBeenCalledOnce();
      const frame = h.written[0];
      expect([...(frame ?? [])]).toEqual([0x88, 17, 0x11, 0x38, ...Buffer.from('preauth-timeout')]); // FIN+close, 4408, the fixed reason
    }
    expect(events.filter((e) => e.event === 'collab.refused')).toHaveLength(10);
    expect(JSON.stringify(events)).not.toContain('203.0.113'); // no address in the log
    expect((await attempt(guard, addr(21), 'stay')).ok).toBe(true); // slots are free: the 11th connects
    // one failed attempt per address from the timeout: with a budget of 2 the address's second failure spends it, so its next upgrade is 429
    expect((await attempt(guard, addr(0), 'fail')).ok).toBe(true);
    expect(await attempt(guard, addr(0), 'fail')).toMatchObject({ ok: false, status: 429 });
    expect((await attempt(guard, addr(1), 'fail')).ok).toBe(true); // another address is unaffected
  });

  it('the socket is destroyed only after the 4408 frame has been handed to the kernel (write callback), never in the same tick as the write', async () => {
    const { guard } = make({ unauthTimeoutMs: 5000 });
    const r = request(addr(3));
    const order: string[] = [];
    let flushed: (() => void) | undefined;
    Object.assign(r.socket, {
      write: (_b: Buffer, cb?: () => void) => { order.push('write'); flushed = cb; return true; }, // a write the kernel has not taken yet: the callback comes later
      destroy: () => { order.push('destroy'); r.socket.emit('close'); },
    });
    const v = await guard.checkUpgrade(r.req, r.socket);
    if (v.ok) guard.onOpen('slow', v.address, v.ticket);
    await vi.advanceTimersByTimeAsync(5000);
    expect(order).toEqual(['write']); // destroy() now would discard the unflushed frame: the client would see a bare end
    flushed?.();
    expect(order).toEqual(['write', 'destroy']);
  });

  it('a write that never completes does not keep the socket forever: it is destroyed one second after the timeout', async () => {
    const { guard } = make({ unauthTimeoutMs: 5000 });
    const r = request(addr(4));
    const destroyed = vi.fn();
    Object.assign(r.socket, { write: () => true, destroy: () => { destroyed(); r.socket.emit('close'); } });
    const v = await guard.checkUpgrade(r.req, r.socket);
    if (v.ok) guard.onOpen('stuck', v.address, v.ticket);
    await vi.advanceTimersByTimeAsync(5999);
    expect(destroyed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(destroyed).toHaveBeenCalledOnce();
  });

  it('the slot is free the moment the timeout fires, even when the socket takes a while to report its close', async () => {
    const { guard } = make({ maxUnauthSockets: 1, unauthTimeoutMs: 5000 });
    const r = request(addr(7));
    Object.assign(r.socket, { write: () => true, destroy: () => undefined }); // a close that has not been reported yet
    const v = await guard.checkUpgrade(r.req, r.socket);
    if (v.ok) guard.onOpen('late', v.address, v.ticket);
    expect((await attempt(guard, addr(8), 'stay')).ok).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await idle(guard, addr(8), 'next')).verdict.ok).toBe(true);
  });

  it('a client that authenticates at 3 seconds stays and is not charged, while an idle one beside it is closed', async () => {
    const { guard } = make({ maxUnauthSockets: 10, attemptsPerWindow: 2, unauthTimeoutMs: 5000 });
    const slow = await idle(guard, addr(1), 'slow');
    const gone = await idle(guard, addr(1), 'gone');
    await vi.advanceTimersByTimeAsync(3000);
    guard.onAuthenticated('slow');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(slow.destroyed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(400_000); // past the limiter's own window and ban, whose expiry timers are the library's
    expect(slow.written).toEqual([]);
    expect(gone.destroyed).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a socket that is not upgraded yet is destroyed without a frame, and nothing is written to one that closed first', async () => {
    const { guard } = make({ unauthTimeoutMs: 5000 });
    const r = request(addr(3));
    const written: Buffer[] = []; const destroyed = vi.fn();
    Object.assign(r.socket, { write: (b: Buffer) => { written.push(b); }, destroy: () => { destroyed(); r.socket.emit('close'); } });
    await guard.checkUpgrade(r.req, r.socket);
    await vi.advanceTimersByTimeAsync(5000);
    expect(destroyed).toHaveBeenCalledOnce();
    expect(written).toEqual([]);
    const closed = await idle(guard, addr(4), 'c');
    guard.onClose('c');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(closed.written).toEqual([]);
    expect(closed.destroyed).not.toHaveBeenCalled();
  });

  it('property: over random open, authenticate, close and time interleavings every slot and timer comes back', async () => {
    let seed = 5;
    const r = (n: number): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return Math.floor((seed / 2 ** 32) * n); };
    for (let round = 0; round < 20; round++) {
      const { guard } = make({ maxUnauthSockets: 8, maxUnauthSocketsPerAddress: 8, attemptsPerWindow: 1000, unauthTimeoutMs: 5000 });
      const open: { id: string; end: () => void }[] = [];
      let n = 0;
      for (let step = 0; step < 60; step++) {
        const op = r(5);
        if (op < 2) {
          const id = `r${String(round)}p${String(n++)}`;
          const rq = request(addr(r(4)));
          Object.assign(rq.socket, { write: () => true, destroy: () => { rq.socket.emit('close'); } });
          const v = await guard.checkUpgrade(rq.req, rq.socket);
          if (v.ok) { guard.onOpen(id, v.address, v.ticket); open.push({ id, end: () => { rq.socket.emit('close'); } }); }
        } else if (op === 2 && open.length > 0) guard.onAuthenticated(open[r(open.length)]?.id ?? '');
        else if (op === 3 && open.length > 0) open.splice(r(open.length), 1)[0]?.end();
        else await vi.advanceTimersByTimeAsync(r(3000));
      }
      for (const o of open) o.end();
      await vi.advanceTimersByTimeAsync(400_000);
      expect(vi.getTimerCount()).toBe(0);
      const again = await Promise.all(Array.from({ length: 8 }, (_, i) => idle(guard, addr(i), `again${String(round)}-${String(i)}`)));
      expect(again.every((h) => h.verdict.ok)).toBe(true); // all 8 global slots are free
      for (const h of again) guard.onClose(`again${String(round)}-${String(again.indexOf(h))}`);
      await vi.advanceTimersByTimeAsync(400_000);
      expect(vi.getTimerCount()).toBe(0);
    }
  });
});

describe('normaliseAddress: a zone id is cut at its first percent sign, in linear time', () => {
  it('cuts the zone id and nothing else', () => {
    expect(normaliseAddress('fe80::1%eth0')).toBe('fe80::1');
    expect(normaliseAddress('fe80::1%')).toBe('fe80::1');
    expect(normaliseAddress('fe80::1%a%b%c')).toBe('fe80::1');
    expect(normaliseAddress('%eth0')).toBeUndefined();
  });

  it('a text that cannot be an address is refused before any work, whatever it holds', () => {
    expect(normaliseAddress('%'.repeat(100_000))).toBeUndefined();
    expect(normaliseAddress(`${'%\n'.repeat(50_000)}x`)).toBeUndefined();
    expect(normaliseAddress(`1.2.3.4${'%'.repeat(200_000)}x`)).toBeUndefined();
    expect(normaliseAddress(`fe80::1%${'e'.repeat(60)}`)).toBe('fe80::1'); // a long but plausible zone id is still stripped
    expect(normaliseAddress('1'.repeat(101))).toBeUndefined();
  });

  it('a forwarded-for header of many entries or very long entries resolves without work on the long ones', () => {
    const trusted = buildTrustedProxies(['10.0.0.0/8']);
    expect(resolveClientAddress(`${'%'.repeat(100_000)},1.2.3.4`, '10.0.0.1', trusted)).toBe('1.2.3.4');
    expect(resolveClientAddress(`1.2.3.4,${'%'.repeat(100_000)}`, '10.0.0.1', trusted)).toBe('10.0.0.1');
  });
});
