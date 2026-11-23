import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import { addressKey, buildTrustedProxies, normaliseAddress, resolveClientAddress, UNKNOWN_ADDRESS } from '@tektum/grimoire-core/users/client-address';
import type { CollabLog } from './events.js';
import { codeFor, REFUSAL_CLOSE_CODES } from './refusal.js';

// The address rules live in core (shared with the HTTP limiters); the names stay importable from here.
export { addressKey, buildTrustedProxies, normaliseAddress, resolveClientAddress };

/** Opaque handle for one admitted upgrade; it travels with the socket to `onOpen` so the outcome is matched to the socket, never to an address. */
export type UpgradeTicket = object;

export type UpgradeVerdict =
  | { ok: true; address: string; ticket: UpgradeTicket }
  | { ok: false; status: 403 | 429 | 503; retryAfterSeconds?: number };

/**
 * Runs before Hocuspocus sees a socket. `checkUpgrade` is async because `rate-limiter-flexible` only has a promise API
 * (the contract says sync; the host awaits it).
 */
export interface UpgradeGuard {
  checkUpgrade(req: IncomingMessage, socket: Duplex): Promise<UpgradeVerdict>;
  resolveAddress(h: Headers, peer?: string): string;
  onOpen(peerId: string, address: string, ticket?: UpgradeTicket): void;
  /** A frame arrived on a socket that may not be authenticated yet; false when the global queued-bytes cap is exceeded (the caller closes the socket). */
  onFrame(peerId: string, bytes: number): boolean;
  onAuthenticated(peerId: string): void;
  onClose(peerId: string): void;
}

export interface UpgradeGuardOptions {
  readonly allowedOrigins: readonly string[];
  /** Comma-list entries of `GRIMOIRE_TRUSTED_PROXY`: an IP or a CIDR. */
  readonly trustedProxies: readonly string[];
  readonly attemptsPerWindow: number;
  readonly windowSeconds: number;
  readonly banSeconds: number;
  readonly maxUnauthSocketsPerAddress: number;
  /** Across all addresses: unauthenticated sockets, and bytes they have sent (queued until authentication). */
  readonly maxUnauthSockets: number;
  readonly maxUnauthQueuedBytes: number;
  readonly log: CollabLog;
  /** Count only: no socket address, user, page or content passed. */
  readonly stats?: (openUnauthenticated: number) => void;
  /** A socket that has not authenticated this long after its upgrade is closed (configured preauth timeout, production default 5 000 ms). */
  readonly unauthTimeoutMs?: number;
}

/** `scheme://host[:port]` in the URL standard's canonical form, or undefined if the text is not exactly an origin. */
export function canonicalOrigin(text: string): string | undefined {
  // Reject path, query, fragment and a trailing slash before parsing: an Origin header never has them and URL would hide them.
  if (!/^[^/]*\/\/[^/?#]*$/.test(text)) return undefined;
  let url: URL;
  try { url = new URL(text); } catch { return undefined; }
  if (url.username !== '' || url.password !== '' || url.host === '') return undefined;
  return `${url.protocol}//${url.host}`;
}

/** Exact match against the allow-list; `null`, a missing header and more than one header are refused. */
export function originAllowed(values: readonly string[], allowed: ReadonlySet<string>): boolean {
  const [only, ...rest] = values;
  if (only === undefined || rest.length > 0) return false;
  const canonical = canonicalOrigin(only);
  return canonical !== undefined && allowed.has(canonical);
}

/** What a client refused by the unauthenticated-socket caps is told to wait (seconds): slots free as soon as sockets authenticate. */
const UNAUTH_RETRY_SECONDS = 2;
const GLOBAL_RETRY_SECONDS = 5;

interface Reservation {
  readonly key: string;
  readonly address: string;
  readonly socket: Duplex;
  peerId?: string;
  /** Counted in `open`/`totals` from admission until first authentication or close. */
  slotHeld: boolean;
  admitted: boolean;
  authenticated: boolean;
  released: boolean;
  bytes: number;
  timer?: NodeJS.Timeout;
}

/** A WebSocket close frame (RFC 6455 section 5.5.1): FIN + opcode 8, unmasked from the server, status code and a short fixed reason. Written by hand because the guard only sees the raw socket, not the `ws` object. */
function closeFrame(code: number, reason: string): Buffer {
  const text = Buffer.from(reason);
  return Buffer.concat([Buffer.from([0x88, 2 + text.length, code >> 8, code & 255]), text]);
}

/** How long a close frame may take to be handed to the kernel before the socket is destroyed anyway. */
const CLOSE_FLUSH_GRACE_MS = 1000;

/**
 * After the upgrade completed the client gets the contract's close code (4408), then the socket is destroyed; before it, the socket is just destroyed.
 * destroy() discards a write the kernel has not taken yet, and the client would see a bare end, so the socket is destroyed from the write callback,
 * with a bounded fallback for a write that never completes.
 */
function refuseAndDestroy(socket: { write(chunk: Buffer, cb?: () => void): unknown; destroy(): unknown; pause?(): unknown }, upgraded: boolean): void {
  if (!upgraded) { socket.destroy(); return; }
  socket.pause?.(); // the reservation is already released: no input (an auth message included) may be handled while the frame is pending
  let done = false;
  const destroy = (): void => {
    if (done) return;
    done = true;
    clearTimeout(fallback);
    socket.destroy();
  };
  const fallback = setTimeout(destroy, CLOSE_FLUSH_GRACE_MS);
  fallback.unref();
  try { socket.write(closeFrame(codeFor(REFUSAL_CLOSE_CODES, 'preauth-timeout'), 'preauth-timeout'), destroy); } catch { destroy(); /* a socket that is already dead cannot be told */ }
}

export function createUpgradeGuard(o?: UpgradeGuardOptions): UpgradeGuard {
  if (!o) {
    // No configuration: let everything through (unit tests of other parts build the guard this way).
    const open = (_h: Headers, peer?: string): string => peer ?? UNKNOWN_ADDRESS;
    return {
      checkUpgrade: (req) => Promise.resolve({ ok: true, address: open(new Headers(), req.socket.remoteAddress), ticket: {} }),
      resolveAddress: open, onOpen: () => undefined, onFrame: () => true, onAuthenticated: () => undefined, onClose: () => undefined,
    };
  }
  const trusted = buildTrustedProxies(o.trustedProxies);
  const allowed = new Set(o.allowedOrigins.map((s) => canonicalOrigin(s)).filter((s): s is string => s !== undefined));
  const limiter = new RateLimiterMemory({ points: o.attemptsPerWindow, duration: o.windowSeconds, blockDuration: o.banSeconds });
  const perKey = new Map<string, number>(); // unauthenticated sockets per address key
  const holding = new Set<Reservation>(); // every reservation that still holds an unauthenticated slot
  let queuedBytes = 0;
  const byPeer = new Map<string, Reservation>();
  const reservations = new WeakMap<UpgradeTicket, Reservation>();

  const resolveAddress = (h: Headers, peer?: string): string => resolveClientAddress(h.get('x-forwarded-for'), peer, trusted);

  /** One failed attempt (a socket that ended without authenticating) costs one point; honest sockets cost none. */
  const fail = (key: string): void => {
    // `consume` rejects with the limiter's own result once over the limit, which is the normal "blocked" outcome, not an error to report.
    limiter.consume(key).catch(() => undefined);
  };

  const freeSlot = (r: Reservation): void => {
    if (!r.slotHeld) return;
    r.slotHeld = false;
    holding.delete(r);
    queuedBytes -= r.bytes;
    const n = (perKey.get(r.key) ?? 1) - 1;
    if (n <= 0) perKey.delete(r.key); else perKey.set(r.key, n);
  };

  /** Runs exactly once per socket, on every path (close, timeout, refusal after the socket went away). */
  const release = (r: Reservation): void => {
    if (r.released) return;
    r.released = true;
    if (r.timer) clearTimeout(r.timer);
    freeSlot(r);
    if (r.admitted && !r.authenticated) fail(r.key);
    if (r.peerId !== undefined) byPeer.delete(r.peerId);
  };

  return {
    async checkUpgrade(req, socket) {
      const headers = new Headers();
      const forwarded = req.headers['x-forwarded-for'];
      if (forwarded !== undefined) headers.set('x-forwarded-for', Array.isArray(forwarded) ? forwarded.join(', ') : forwarded);
      const address = resolveAddress(headers, req.socket.remoteAddress);
      const key = addressKey(address);
      // Registered before any await, so a socket that closes during one still releases: the reservation is bound to this socket object.
      const r: Reservation = { key, address, socket, slotHeld: false, admitted: false, authenticated: false, released: false, bytes: 0 };
      // A reset socket would otherwise be an uncaught 'error' event; `close` follows and does the accounting.
      socket.on('error', () => undefined);
      socket.once('close', () => { release(r); });
      // Origin first and not counted: a browser on a hostile page cannot forge it, so it must not be able to get a user's address banned.
      // rawHeaders sees every Origin header; `req.headers` would fold several into one string.
      const origins: string[] = [];
      for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) if (req.rawHeaders[i]?.toLowerCase() === 'origin') origins.push(req.rawHeaders[i + 1] ?? '');
      if (!originAllowed(origins, allowed)) {
        o.log.emit('collab.upgrade_refused', { reason: 'origin', status: 403 });
        return { ok: false, status: 403 };
      }
      // Then the attempt limit, before authentication or any database work. Only failed attempts are counted (see `release`), so
      // honest users sharing an address are never banned; at the limit the refusal itself starts the ban.
      const used = await limiter.get(key);
      if (r.released) return { ok: false, status: 429 }; // the socket went away during the await: nothing was reserved, nothing is charged
      if ((used?.consumedPoints ?? 0) >= o.attemptsPerWindow) {
        let retryAfterSeconds = o.banSeconds;
        try {
          await limiter.consume(key);
        } catch (e) {
          if (typeof e === 'object' && e !== null && 'msBeforeNext' in e && typeof e.msBeforeNext === 'number') retryAfterSeconds = Math.max(1, Math.ceil(e.msBeforeNext / 1000));
          const first = typeof e === 'object' && e !== null && 'consumedPoints' in e && e.consumedPoints === o.attemptsPerWindow + 1;
          if (first) o.log.emit('collab.upgrade_refused', { reason: 'rate', status: 429 }); // once per ban, so a flood cannot flood the log
        }
        return { ok: false, status: 429, retryAfterSeconds };
      }
      // No await from here to admission: the counts read below are the counts at admission.
      if ((perKey.get(key) ?? 0) >= o.maxUnauthSocketsPerAddress) {
        o.log.emit('collab.upgrade_refused', { reason: 'unauthenticated-sockets', status: 429 });
        return { ok: false, status: 429, retryAfterSeconds: UNAUTH_RETRY_SECONDS };
      }
      if (holding.size >= o.maxUnauthSockets || queuedBytes >= o.maxUnauthQueuedBytes) {
        o.log.emit('collab.upgrade_refused', { reason: 'unauthenticated-global', status: 503 });
        return { ok: false, status: 503, retryAfterSeconds: GLOBAL_RETRY_SECONDS };
      }
      r.admitted = true;
      r.slotHeld = true;
      holding.add(r);
      perKey.set(key, (perKey.get(key) ?? 0) + 1);
      r.timer = setTimeout(() => {
        if (r.authenticated || r.released) return;
        o.log.emit('collab.refused', { code: 'preauth-timeout' });
        release(r); // frees the slot and counts one failed attempt for the address, once
        if (holding.size === 0) o.stats?.(0);
        refuseAndDestroy(socket, r.peerId !== undefined);
      }, o.unauthTimeoutMs ?? 5000);
      r.timer.unref();
      const ticket: UpgradeTicket = {};
      reservations.set(ticket, r);
      return { ok: true, address, ticket };
    },
    resolveAddress,
    onOpen(peerId, _address, ticket) {
      const r = ticket !== undefined ? reservations.get(ticket) : undefined;
      if (!r) return;
      r.peerId = peerId;
      if (!r.released) byPeer.set(peerId, r);
    },
    onFrame(peerId, bytes) {
      const r = byPeer.get(peerId);
      if (!r?.slotHeld) return true;
      r.bytes += bytes;
      queuedBytes += bytes;
      return queuedBytes <= o.maxUnauthQueuedBytes;
    },
    onAuthenticated(peerId) {
      const r = byPeer.get(peerId);
      if (!r) return;
      r.authenticated = true;
      if (r.timer) clearTimeout(r.timer);
      freeSlot(r);
    },
    onClose(peerId) {
      const r = byPeer.get(peerId);
      if (r) release(r);
    },
  };
}
