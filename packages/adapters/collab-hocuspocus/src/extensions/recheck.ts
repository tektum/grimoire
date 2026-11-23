import { setImmediate as yieldToLoop } from 'node:timers/promises';
import type { Extension, HookPayloadByName } from '@hocuspocus/server';
import type { PageAccess } from '@tektum/grimoire-core/authorize';
import type { AccessRequest } from '@tektum/grimoire-core/ports/access-store';
import type { CollabDeps } from '@tektum/grimoire-core/ports/collaboration-host';
import { readContext, updateContext } from '../context.js';
import type { AccessClosedReason, CollabLog } from '../events.js';
import { codeFor, REFUSAL_CLOSE_CODES, SESSION_CLOSES } from '../refusal.js';
import { bounded, verify } from './auth.js';
import type { Verified } from './auth.js';

type Connection = HookPayloadByName['connected']['connection'];
type CloseReason = 'access-changed' | 'session-expired' | 'try-again' | 'invalid-token';

/** Most requests in one `pageAccessMany` call (one database round trip): 1,000 open documents are one query, 2,500 are three. */
export const RECHECK_BATCH = 1000;
/** A round's database part gives up after this long: a hung database is a failed round, and the next tick is not blocked behind it. */
export const RECHECK_DATABASE_TIMEOUT_MS = 5000;
/** The verifier (a key fetch at worst) has this long to answer a token presented on an open connection. */
export const TOKEN_VERIFY_TIMEOUT_MS = 3000;
/** Token presentations per connection per window; the rest are ignored (not verified, not closed): a client cannot make the verifier work for free. */
export const TOKEN_PRESENTATIONS_PER_WINDOW = 5;
export const TOKEN_WINDOW_MS = 60_000;
/** A presented token longer than this is not a token (the verifier would be handed an attacker-sized string). */
export const MAX_TOKEN_CHARS = 16 * 1024;
/** Connections handled between two yields to the event loop while applying a round's decisions. */
const SLICE = 250;

/**
 * Consecutive failed rounds (database down or hanging) the host keeps connections through before it fails closed with `try-again`:
 * never fewer than 3, and long enough to cover 120 s. A blip of a round or two is invisible; an outage cannot extend access without
 * bound. With the default 60 s interval that is 3 minutes of stale access at most; with 1 s it is 2 minutes. Session expiry never waits
 * for the database.
 */
export const maxFailedRounds = (intervalSeconds: number): number => Math.max(3, Math.ceil(120 / intervalSeconds));

export interface RecheckOptions {
  readonly deps: CollabDeps;
  readonly log: CollabLog;
}

export interface Recheck {
  readonly extension: Extension;
  /** One round now (the timer calls this); a round that is still running makes this a no-op. For tests. */
  round(): Promise<void>;
  /** Clears the timer for good (host shutdown). */
  stop(): void;
  /** Document connections being watched. */
  readonly size: number;
}

interface Tracked {
  readonly documentName: string;
  readonly userId: string;
  readonly descopeUserId: string;
  level: 'read-write' | 'read-only';
  expiresAt: number;
  readonly epoch: number;
  windowStart: number;
  presentations: number;
}

/** The token inside what a client sends on a token round: the handshake form `g1.` + base64url JSON `{t, v, e}` (only `t` counts), or a bare token. */
function tokenOf(presented: string): string | undefined {
  if (presented.length > MAX_TOKEN_CHARS) return undefined;
  if (!presented.startsWith('g1.')) return presented;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(presented.slice(3), 'base64url').toString('utf8'));
    if (typeof parsed === 'object' && parsed !== null && 't' in parsed && typeof parsed.t === 'string') return parsed.t;
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Access re-check and session token round.
 *
 * One timer runs while at least one document connection is open. Each round: expired sessions are closed first (no database needed);
 * then ONE `pageAccessMany` call (per bounded batch) answers for every open document: the collapsed access decision includes the user
 * row (gone or suspended: no access), the page (gone or trashed), the collection and the grant, the level and the epoch. Outcomes:
 *  - no access (user gone or suspended, access removed, page or collection gone or trashed), a changed epoch, or a changed level
 *    (lowered or raised): closed 4205 `access-changed`. One mechanism: the client reconnects and gets the connect-time answer
 *    (4404/4403 where existence is hidden, or its new level). The connection was already admitted, so nothing leaks;
 *  - a token presented on the open connection that does not verify, or is for another user: closed 4401 `invalid-token`.
 * A connection outlives a change or its session by at most one interval (and a round's own duration).
 */
export function createRecheck(o: RecheckOptions): Recheck {
  const { deps, log } = o;
  const intervalMs = deps.config.collab.recheckSeconds * 1000;
  const failedLimit = maxFailedRounds(deps.config.collab.recheckSeconds);
  const tracked = new Map<Connection, Tracked>();
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let stopped = false;
  let failedRounds = 0;

  const clearTimer = (): void => {
    clearInterval(timer);
    timer = undefined;
  };

  const untrack = (c: Connection): void => {
    tracked.delete(c);
    if (tracked.size === 0) { clearTimer(); failedRounds = 0; }
  };

  const closeCode = (reason: CloseReason): number =>
    reason === 'access-changed' || reason === 'session-expired' ? SESSION_CLOSES[reason] : codeFor(REFUSAL_CLOSE_CODES, reason);

  /** Closes one document connection (the socket and its other documents stay); a failing close must not stop the round. */
  const closeOne = (c: Connection, t: Tracked, reason: CloseReason, logged?: AccessClosedReason): void => {
    if (logged !== undefined) log.emit('collab.access_closed', { pageId: t.documentName, reason: logged });
    try { c.close({ code: closeCode(reason), reason }); } catch { /* the socket is already going away */ }
    untrack(c);
  };

  let queryInFlight = false;
  const keyOf = (t: Tracked): string => `${t.userId}\u0000${t.documentName}`;

  /** The decision for each distinct (user, page), in bounded batches; `undefined` when the database could not answer. */
  const decide = async (live: readonly (readonly [Connection, Tracked])[]): Promise<Map<string, PageAccess> | undefined> => {
    const requests = new Map<string, AccessRequest>();
    for (const [, t] of live) requests.set(keyOf(t), { userId: t.userId, pageId: t.documentName });
    const keys = [...requests.keys()];
    const out = new Map<string, PageAccess>();
    // A query that timed out is still running in the database: the next round does not start another one on top of it (that would stack calls while the
    // store is unresponsive); it counts as a failed round until the hung call ends.
    if (queryInFlight) return undefined;
    try {
      for (let i = 0; i < keys.length; i += RECHECK_BATCH) {
        const chunk = keys.slice(i, i + RECHECK_BATCH);
        const call = deps.access.pageAccessMany(chunk.map((k) => requests.get(k) as AccessRequest));
        queryInFlight = true;
        const done = (): void => { queryInFlight = false; };
        call.then(done, done);
        const answers = await bounded(call, RECHECK_DATABASE_TIMEOUT_MS);
        chunk.forEach((k, j) => { out.set(k, answers[j] ?? { result: 'not-found' }); });
      }
    } catch {
      return undefined;
    }
    return out;
  };

  const apply = (c: Connection, t: Tracked, a: PageAccess): boolean => {
    if (a.result !== 'allowed' || (a.access !== 'read-write' && a.access !== 'read-only')) { closeOne(c, t, 'access-changed', 'no-access'); return true; }
    if (a.epoch !== t.epoch) { closeOne(c, t, 'access-changed', 'epoch'); return true; }
    if (a.access === t.level) return false;
    closeOne(c, t, 'access-changed', 'access-changed'); // a level changed either way: the reconnect is authorised afresh and the editor learns its scope
    return true;
  };

  async function doRound(): Promise<void> {
    const startedAt = deps.clock.now();
    let closed = 0;
    const live: (readonly [Connection, Tracked])[] = [];
    for (const [c, t] of [...tracked]) {
      if (t.expiresAt <= startedAt) { closeOne(c, t, 'session-expired', 'session-expired'); closed++; } else live.push([c, t]);
    }
    if (live.length > 0) {
      const decisions = await decide(live);
      if (decisions === undefined) {
        failedRounds++;
        log.emit('collab.recheck_skipped', { reason: 'database' });
        if (failedRounds >= failedLimit) {
          for (const [c, t] of live) if (tracked.has(c)) { closeOne(c, t, 'try-again', 'recheck-unavailable'); closed++; }
        }
      } else {
        failedRounds = 0;
        let n = 0;
        for (const [c, t] of live) {
          if (++n % SLICE === 0) await yieldToLoop();
          if (!tracked.has(c)) continue; // closed by the client or by something else while this round waited
          const a = decisions.get(keyOf(t));
          if (a !== undefined && apply(c, t, a)) closed++;
        }
      }
      for (const [c, t] of live) {
        if (tracked.has(c) && t.expiresAt - startedAt <= 2 * intervalMs) {
          try { c.requestToken(); } catch { /* a closing socket */ }
        }
      }
    }
    log.emit('collab.recheck_round', { connections: live.length + closed, closed, ms: deps.clock.now() - startedAt });
  }

  const round = async (): Promise<void> => {
    if (running) return; // a long round is skipped over, never stacked
    running = true;
    try { await doRound(); } finally { running = false; }
  };

  const extension: Extension = {
    extensionName: 'grimoire-recheck',
    priority: 900,

    async connected(data: HookPayloadByName['connected']): Promise<void> {
      if (stopped) return;
      const c = readContext(data.context);
      if (c.userId === undefined || c.descopeUserId === undefined || c.accessLevel === undefined || c.expiresAt === undefined || c.epoch === undefined) return;
      const connection = data.connection;
      tracked.set(connection, {
        documentName: data.documentName, userId: c.userId, descopeUserId: c.descopeUserId, level: c.accessLevel,
        expiresAt: c.expiresAt, epoch: c.epoch, windowStart: deps.clock.now(), presentations: 0,
      });
      connection.onClose(() => { untrack(connection); });
      if (timer === undefined) {
        timer = setInterval(() => { void round().catch(() => undefined); }, intervalMs);
        timer.unref(); // the re-check must never keep the process alive
      }
    },

    /**
     * A token presented on an open connection (the answer to `requestToken`, or unprompted). Same verifier and same rules as at connect;
     * the SAME subject is required, and nothing about the connection but its expiry can change. A token for another user closes the
     * connection (an attack, or a client mixing sessions); a token that does not verify is refused and the connection keeps its own
     * expiry; an unreachable verifier changes nothing. The token is never logged or kept.
     */
    async onTokenSync(data: HookPayloadByName['onTokenSync']): Promise<void> {
      const t = tracked.get(data.connection);
      if (t === undefined) return;
      const now = deps.clock.now();
      if (now - t.windowStart >= TOKEN_WINDOW_MS) { t.windowStart = now; t.presentations = 0; }
      if (t.presentations >= TOKEN_PRESENTATIONS_PER_WINDOW) { log.emit('collab.token_sync_failed', { pageId: t.documentName, reason: 'rate-limited' }); return; }
      t.presentations++;
      const token = tokenOf(data.token);
      let v: Verified;
      try {
        v = token === undefined ? { kind: 'invalid' } : await bounded(verify(deps, token), TOKEN_VERIFY_TIMEOUT_MS);
      } catch {
        v = { kind: 'unavailable' };
      }
      if (!tracked.has(data.connection)) return;
      if (v.kind === 'unavailable') { log.emit('collab.auth_unavailable', { source: 'verifier' }); return; }
      if (v.kind !== 'ok') {
        log.emit('collab.token_sync_failed', { pageId: t.documentName, reason: 'invalid' });
        // The provider answers the server's request at the boundary with the token it has, which may have expired in the meantime: once the connection's
        // own expiry has passed the session is over, whatever the stale token was (R4.14), and the sweep's reason is the true one.
        if (t.expiresAt <= deps.clock.now()) closeOne(data.connection, t, 'session-expired', 'session-expired');
        else closeOne(data.connection, t, 'invalid-token'); // the client must sign in again
        return;
      }
      if (v.userId !== t.descopeUserId) {
        log.emit('collab.token_sync_failed', { pageId: t.documentName, reason: 'user-mismatch' });
        closeOne(data.connection, t, 'invalid-token');
        return;
      }
      t.expiresAt = v.expiresAt;
      updateContext(data.connection.context, { expiresAt: v.expiresAt });
    },
  };

  return {
    extension,
    round,
    stop() { stopped = true; clearTimer(); },
    get size() { return tracked.size; },
  };
}
