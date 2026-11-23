import type { Extension, HookPayloadByName } from '@hocuspocus/server';
import type { VerifyResult } from '@tektum/grimoire-core/ports/auth-verifier';
import type { CollabDeps } from '@tektum/grimoire-core/ports/collaboration-host';
import type { UserRecord } from '@tektum/grimoire-core/ports/user-store';
import type { PageAccess } from '@tektum/grimoire-core/authorize';
import type { CollabLog } from '../events.js';
import { readContext } from '../context.js';
import type { ConnectionContext } from '../context.js';
import type { PeerRegistry } from '../peers.js';
import { readHandshake } from '../handshake.js';
import { Refusal } from '../refusal.js';
import type { UpgradeGuard } from '../upgrade-guard.js';

/** Lowercase canonical UUID: the only document name that reaches the database or the verifier (R4.1). */
export const DOCUMENT_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Bound on the database part of authentication (user row and access, together). Well inside the five-second pre-sign-in window, so a
 * hung database ends in a `try-again` refusal (not charged to the address) rather than in the window's timeout (charged).
 */
export const AUTH_DATABASE_TIMEOUT_MS = 2000;

/** The subject of the migration's system user (0004): it owns rows, it is never a session. */
const SYSTEM_SUBJECT = 'system:migration';

export interface AuthOptions {
  readonly deps: CollabDeps;
  readonly log: CollabLog;
  readonly peers: PeerRegistry;
  readonly guard: UpgradeGuard;
  /** Takes the per-user, page and server admission of the document at arrival (the limits extension); throws the refusal. Called last, so a refusal before it leaves nothing taken. */
  readonly admit?: (data: { context: unknown; socketId: string; documentName: string; connectionConfig: object }, userId: string) => void;
}

export type Verified = { kind: 'ok'; userId: string; expiresAt: number; profile?: Extract<VerifyResult, { kind: 'ok' }>['profile'] } | { kind: 'invalid' } | { kind: 'unavailable' };

/** The verifier's answer, narrowed: only a literal `ok` with a non-empty subject and a finite future expiry admits; a throw is an outage. */
export async function verify(deps: CollabDeps, token: string): Promise<Verified> {
  let r: VerifyResult;
  try { r = await deps.verifier.verify(token); } catch { return { kind: 'unavailable' }; }
  if (r.kind === 'service-unavailable') return { kind: 'unavailable' };
  if (r.kind !== 'ok' || typeof r.userId !== 'string' || r.userId === '' || !Number.isFinite(r.expiresAt) || r.expiresAt <= deps.clock.now()) return { kind: 'invalid' };
  return { kind: 'ok', userId: r.userId, expiresAt: r.expiresAt, ...(r.profile !== undefined ? { profile: r.profile } : {}) };
}

type Resolved = { kind: 'refused'; refusal: Refusal } | { kind: 'allowed'; user: UserRecord; access: Extract<PageAccess, { result: 'allowed' }> };

/**
 * The database part: the user row, then the collapsed access answer. Every page denial is the same `not-found` (R6.4): the host never
 * sees why, and both refusals take one user lookup and one access query. Rejects when the database fails.
 */
async function resolve(deps: CollabDeps, token: string, v: Extract<Verified, { kind: 'ok' }>, pageId: string): Promise<Resolved> {
  const user = await deps.resolveUser(token, { userId: v.userId, ...(v.profile !== undefined ? { profile: v.profile } : {}) });
  // The row must be the verified subject's own, and never the system user: anything else is no user.
  if (user === undefined || user.descopeUserId !== v.userId || user.descopeUserId === SYSTEM_SUBJECT || typeof user.id !== 'string' || user.id === '') {
    return { kind: 'refused', refusal: new Refusal('forbidden', 'no-user') };
  }
  // The provisioner answers `ok` for an existing suspended user: refusing is this caller's job.
  if (user.suspended !== false) return { kind: 'refused', refusal: new Refusal('forbidden', 'suspended') };
  const access = await deps.access.pageAccess({ userId: user.id, pageId });
  if (access.result !== 'allowed' || (access.access !== 'read-write' && access.access !== 'read-only')) return { kind: 'refused', refusal: new Refusal('not-found') };
  return { kind: 'allowed', user, access };
}

/** `work` or a rejection after `ms`; the late result is dropped. */
export async function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { reject(new Error('timeout')); }, ms); });
  try { return await Promise.race([work, timeout]); } finally { clearTimeout(timer); }
}

export function createAuthExtension(o: AuthOptions): Extension {
  const { deps } = o;
  /**
   * An outage is not a failed sign-in: the address must not move toward a ban, nor count against the throttle, because of our verifier
   * or database. The guard charges a socket that ends unauthenticated; marking it done here releases its pre-sign-in slot without a
   * charge (the refusal still closes the socket shortly after, see guard.ts).
   */
  const unavailable = (context: unknown, source: 'verifier' | 'database'): Refusal => {
    const peerId = readContext(context).peerId;
    if (peerId !== undefined) o.guard.onAuthenticated(peerId);
    o.log.emit('collab.auth_unavailable', { source });
    return new Refusal('try-again');
  };

  return {
    extensionName: 'grimoire-auth',
    priority: 1000,

    async onConnect(data: HookPayloadByName['onConnect']): Promise<void> {
      if (!DOCUMENT_NAME.test(data.documentName)) throw new Refusal('bad-document-name');
    },

    /**
     * Contracts section 7, fail closed: admitted only after (1) the token verifies `ok` and is unexpired, (2) the user row of that subject
     * exists and is not suspended, (3) the collapsed access answer allows this page. Any other outcome refuses. No database call before
     * (1). The context keeps ids, level, expiry and epoch; the token is not kept (R4.8).
     */
    async onAuthenticate(data: HookPayloadByName['onAuthenticate']): Promise<Partial<ConnectionContext>> {
      const hs = readHandshake(data.token, deps.config);
      const v = await verify(deps, hs.token);
      if (v.kind === 'unavailable') throw unavailable(data.context, 'verifier');
      if (v.kind !== 'ok') throw new Refusal('invalid-token');
      let r: Resolved;
      try {
        r = await bounded(resolve(deps, hs.token, v, data.documentName), AUTH_DATABASE_TIMEOUT_MS);
      } catch {
        throw unavailable(data.context, 'database');
      }
      if (r.kind !== 'allowed') throw r.refusal;
      data.connectionConfig.readOnly = r.access.access !== 'read-write';
      o.admit?.(data, r.user.id); // decided now, in arrival order, before the client is told it is authenticated and before the page loads
      return { userId: r.user.id, descopeUserId: v.userId, accessLevel: r.access.access, expiresAt: v.expiresAt, epoch: r.access.epoch };
    },

    /**
     * Hocuspocus drops sync step 2 and update messages of a connection whose `readOnly` is set (MessageReceiver, 4.8.0). It reads the flag
     * from the Connection, set once from `connectionConfig`; this re-derives it from the context before every message, so a connection
     * that is not literally read-write can never write, whatever later code does to the flag.
     */
    async beforeHandleMessage(data: HookPayloadByName['beforeHandleMessage']): Promise<void> {
      if (readContext(data.context).accessLevel === 'read-write' || data.connection.readOnly) return;
      data.connection.readOnly = true;
      o.log.emit('collab.read_only_mismatch', { pageId: data.documentName });
    },

    async connected(data: HookPayloadByName['connected']): Promise<void> {
      const c = readContext(data.context);
      if (c.peerId === undefined || c.userId === undefined || c.accessLevel === undefined) return;
      o.peers.markAuthenticated(c.peerId, c.userId, data.documentName);
      const { peerId } = c;
      data.connection.onClose(() => { o.peers.releaseDocument(peerId, data.documentName); });
      o.guard.onAuthenticated(c.peerId);
      o.log.emit('collab.connected', { pageId: data.documentName, accessLevel: c.accessLevel });
    },
  };
}
