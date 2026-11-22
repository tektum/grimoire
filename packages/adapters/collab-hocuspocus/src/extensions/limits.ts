import { getHeapStatistics } from 'node:v8';
import type { Clock } from '@tektum/grimoire-core/ports/clock';
import type { Document, Extension, HookPayloadByName } from '@hocuspocus/server';
import type { CollabConfig } from '@tektum/grimoire-core/ports/config';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import * as Y from 'yjs';
import { readContext } from '../context.js';
import type { CollabLog, LimitName } from '../events.js';
import { Refusal, codeFor, REFUSAL_CLOSE_CODES } from '../refusal.js';
import { createUserAccounting } from '../user-accounting.js';

/** Close codes of in-session refusals (connect-time ones are in `refusal.ts`). 4429 and 4422 are the contract's; 4423 is ours: the contract gives `state-cap` no close code. */
export const SESSION_CLOSE_CODES = { 'malformed-update': 4422, 'state-cap': 4423, 'rate-limited': 4429 } as const;
type SessionRefusalCode = keyof typeof SESSION_CLOSE_CODES;

/** What a client receives as a stateless message: refusals and warnings share one JSON shape (contract section 6). */
export const statelessMessage = (kind: 'refusal' | 'warning', code: string): string => JSON.stringify({ grimoire: 1, kind, code });

/** Hocuspocus closes the document connection with `code` and `reason` of whatever a message hook throws; the message stays empty so nothing is logged. */
class SessionRefusal extends Error {
  readonly code: number;
  readonly reason: string;
  constructor(reason: SessionRefusalCode) {
    super('');
    this.code = SESSION_CLOSE_CODES[reason];
    this.reason = reason;
  }
}

/**
 * Presence (awareness) budget per socket: 3 updates per 100 ms, about 30 a second. Measured on the real server: typing at 15 characters a second
 * with cursor movement sends about 15 presence updates a second, dragging a selection 30 to 60. Over budget an update is dropped, never relayed
 * and never a reason to close; the newest dropped one is replayed when the window ends, so the last position still arrives, at most 100 ms late.
 * The contracts have no setting for this, so it is a constant.
 */
const PRESENCE_POINTS = 3;
const PRESENCE_WINDOW_SECONDS = 0.1;
/**
 * Reconnect backlog. A Hocuspocus provider queues every edit made while it was offline as its own message and sends them all as soon as the
 * socket answers, which is a burst of hundreds or thousands of document messages (500 queued edits tripped the 300 budget). Whether a frame is
 * backlog cannot be told from the frame, so the first 6 seconds of a document connection draw from a separate allowance of 5,000 messages
 * (a very long offline session: one message per edit) instead of the document budget; once either is used up the budget applies. The allowance belongs to a
 * user and page, not a socket, and refills only 60 seconds after it was first drawn on, so reconnecting does not renew it: an authenticated flooder is bounded to the normal
 * budget (300 per 10 s, 30 a second) plus 5,000 per 60 s (83 a second), about 113 a second at the very worst, under 4 times the normal rate.
 */
const BACKLOG_SECONDS = 6;
const BACKLOG_MESSAGES = 5_000;
/** The allowance of a user and page refills this many seconds after it was first drawn on (the cooldown): reconnecting does not refill it. */
const BACKLOG_COOLDOWN_SECONDS = 60;
/** The Hocuspocus message type of presence updates: Awareness (1). Everything else, QueryAwareness (3) included, counts against the document budget. */
const AWARENESS = 1;
const QUERY_AWARENESS = 3;

/** One lib0 variable-length unsigned integer at `at` (padded encodings such as 0x80 0x00 are accepted, as the library accepts them), and where it ends. */
function readVarUint(frame: Uint8Array, at: number): { value: number; next: number } | undefined {
  let value = 0; let i = at;
  for (let shift = 0; shift <= 28; shift += 7) {
    const b = frame[i++];
    if (b === undefined) return undefined;
    value += (b & 127) * 2 ** shift;
    if (b < 128) return { value, next: i };
  }
  return undefined;
}

/** The fields of a frame: the document name is skipped, then the message type, then (for a sync message) its subtype (0 = step 1 request, 1 = step 2 answer, 2 = update); read the way the library reads them. */
export function frameFields(frame: Uint8Array): { type: number; subtype: number | undefined } | undefined {
  const name = readVarUint(frame, 0);
  if (name === undefined) return undefined;
  const type = readVarUint(frame, name.next + name.value);
  if (type === undefined) return undefined;
  return { type: type.value, subtype: readVarUint(frame, type.next)?.value };
}

/** The message type of a frame, read without decoding the rest; lib0, which has the reader, is not a declared dependency here. */
export function messageType(frame: Uint8Array): number | undefined {
  return frameFields(frame)?.type;
}

/** The sync subtype of a frame (see `frameFields`), or undefined. */
export function messageSubtype(frame: Uint8Array): number | undefined {
  return frameFields(frame)?.subtype;
}

export interface LimitsOptions {
  readonly config: CollabConfig;
  readonly log: CollabLog;
  /** Bytes of heap in use; tests inject a number, production reads V8. */
  readonly memoryUsed?: () => number;
  readonly clock: Clock;
}

interface StateRecord {
  /**
   * Estimate of the document's encoded state. It is exact for an append and can undercount by a few bytes (at most 12, pinned by `state-delta.test.ts`) when an
   * insert splits an existing run, because the merge does not integrate. That is the whole overshoot: the next near-cap check encodes the real state.
   */
  bytes: number;
  warned: boolean;
}

const heapUsed = (): number => getHeapStatistics().used_heap_size;
const encodedSize = (doc: Y.Doc): number => Y.encodeStateAsUpdate(doc).byteLength;

/** The encoded size after `update`, from deltas: the state is encoded once and merged with the update; the document is never cloned (not an upper bound: see `StateRecord`). */
function estimateAfter(doc: Y.Doc, update: Uint8Array): number {
  return Y.mergeUpdates([Y.encodeStateAsUpdate(doc), update]).byteLength;
}

export interface LimitsExtension extends Extension { readonly counts: () => { users: number; sockets: number; documents: number; windows: number } }

export function createLimitsExtension(o: LimitsOptions): LimitsExtension {
  const c = o.config;
  const warnBytes = Math.floor((c.maxStateBytes * c.stateWarnPercent) / 100);
  const memoryBytes = Math.floor((c.memoryLimitBytes * c.memoryGuardPercent) / 100);
  const memoryUsed = o.memoryUsed ?? heapUsed;
  const accounting = createUserAccounting({ sockets: c.maxSocketsPerUser, documents: c.maxDocumentsPerUser, bytesPerWindow: c.bytesPerSecondPerUser, windowMs: 1000 }, o.clock);

  // The rate counter is the library's. Its key is the user and page, so reconnecting (a fresh socket) does not renew the budget; a socket without a known user (never after authentication) falls back to the socket id.
  const limiter = new RateLimiterMemory({ points: c.messagesPerWindow, duration: c.rateWindowSeconds });
  const limitedSockets = new Set<string>();
  const backlogLimiter = new RateLimiterMemory({ points: BACKLOG_MESSAGES, duration: BACKLOG_COOLDOWN_SECONDS });
  const budgetKey = (context: unknown, socketId: string, documentName: string): string => {
    const userId = readContext(context).userId;
    return userId === undefined ? socketId : `${userId}\0${documentName}`;
  };
  const backlogUntil = new Map<string, number>();
  const presenceLimiter = new RateLimiterMemory({ points: PRESENCE_POINTS, duration: PRESENCE_WINDOW_SECONDS });
  /** The awareness frame being handled per connection, the newest dropped one waiting for the next window, and when each socket last logged a drop. */
  const currentAwareness = new WeakMap<object, Uint8Array>();
  const heldAwareness = new WeakMap<object, Uint8Array>();
  const flushTimers = new Set<NodeJS.Timeout>();
  const presenceLogged = new Map<string, number>();

  // Own in-memory connection counts (R4.15, R4.45): Hocuspocus has none. Keyed by socket so a repeated hook cannot count twice.
  const pageSockets = new Map<string, Set<string>>();
  const socketPages = new Map<string, number>();
  let total = 0;

  const states = new WeakMap<Document, StateRecord>();
  const idleTimers = new Map<string, NodeJS.Timeout>();

  const record = (doc: Document): StateRecord => {
    let r = states.get(doc);
    if (!r) { r = { bytes: encodedSize(doc), warned: false }; states.set(doc, r); }
    return r;
  };

  const limitHit = (limit: LimitName, reason: string, value: number, max: number, pageId?: string): Refusal => {
    o.log.emit('collab.limit_hit', { limit, value, max, ...(pageId !== undefined ? { pageId } : {}) });
    return new Refusal(reason);
  };

  /** In-session refusal: the sender gets the stateless message first, then the throw closes its document connection. */
  const refuseMessage = (connection: { sendStateless(p: string): void }, reason: SessionRefusalCode): SessionRefusal => {
    o.log.emit('collab.refused', { code: reason });
    try { connection.sendStateless(statelessMessage('refusal', reason)); } catch { /* a socket already closing cannot be told */ }
    return new SessionRefusal(reason);
  };

  /** `pending` is an update accepted but not yet applied: the size after it is what counts. */
  const warnIfOver = (doc: Document, r: StateRecord, only?: { sendStateless(p: string): void }, pending?: Uint8Array, exact = false): void => {
    if (r.warned || r.bytes <= warnBytes) return;
    if (!exact) r.bytes = pending ? estimateAfter(doc, pending) : encodedSize(doc);
    if (r.bytes <= warnBytes) return;
    r.warned = true;
    o.log.emit('collab.state_warning', { pageId: doc.name, stateBytes: r.bytes, maxBytes: c.maxStateBytes });
    for (const conn of only ? [only] : doc.getConnections()) conn.sendStateless(statelessMessage('warning', 'state-warning'));
  };

  const clearIdle = (name: string): void => {
    const t = idleTimers.get(name);
    if (t) { clearTimeout(t); idleTimers.delete(name); }
  };

  return {
    extensionName: 'grimoire-limits',
    priority: 800,
    counts: () => accounting.counts(),

    /** Runs before `onAuthenticate`: the cheapest checks first, and no database or verifier work for a refused connection. */
    async onConnect(data: HookPayloadByName['onConnect']): Promise<void> {
      if (total >= c.maxConnections) throw limitHit('connections', 'server-full', total, c.maxConnections);
      const onPage = pageSockets.get(data.documentName)?.size ?? 0;
      if (onPage >= c.maxConnectionsPerPage) throw limitHit('page-connections', 'page-full', onPage, c.maxConnectionsPerPage, data.documentName);
      if (data.instance.documents.has(data.documentName)) return; // only a page that is not open yet adds a document and its memory
      const open = data.instance.getDocumentsCount();
      if (open >= c.maxOpenDocuments) throw limitHit('open-documents', 'documents-full', open, c.maxOpenDocuments);
      const used = memoryUsed();
      if (used > memoryBytes) throw limitHit('memory', 'memory-guard', used, memoryBytes);
    },

    async connected(data: HookPayloadByName['connected']): Promise<void> {
      // A connection the document has already dropped is counted nowhere: its close ran before this hook and nothing would release the slot.
      const dropped = (data.connection.document as { hasConnection?: (c: unknown) => boolean }).hasConnection;
      if (typeof dropped === 'function' && !dropped.call(data.connection.document, data.connection)) return;
      /** A refused document closes alone when the socket carries other admitted documents; a socket whose only document is refused closes whole (it is signed in by now and no longer under the pre-sign-in limits). */
      const refuse = (reason: 'server-full' | 'page-full' | 'full-for-you', otherDocuments: number): void => {
        const code = codeFor(REFUSAL_CLOSE_CODES, reason);
        if (otherDocuments > 0) data.connection.close({ code, reason }); else data.connection.webSocket.close(code, reason);
      };
      let counted = false;
      let sockets = pageSockets.get(data.documentName);
      if (!sockets) { sockets = new Set(); pageSockets.set(data.documentName, sockets); }
      if (!sockets.has(data.socketId)) {
        // The checks in `onConnect` ran before authentication finished, so sockets that connected at the same moment all passed them: counted again here,
        // where the count is raised, so the caps hold exactly.
        const refused = total >= c.maxConnections
          ? { limit: 'connections' as const, reason: 'server-full' as const, value: total, max: c.maxConnections }
          : sockets.size >= c.maxConnectionsPerPage
            ? { limit: 'page-connections' as const, reason: 'page-full' as const, value: sockets.size, max: c.maxConnectionsPerPage }
            : undefined;
        if (refused !== undefined) {
          if (sockets.size === 0) pageSockets.delete(data.documentName);
          refuse(refused.reason, socketPages.get(data.socketId) ?? 0);
          throw limitHit(refused.limit, refused.reason, refused.value, refused.max, refused.limit === 'page-connections' ? data.documentName : undefined);
        }
        sockets.add(data.socketId);
        total++;
        socketPages.set(data.socketId, (socketPages.get(data.socketId) ?? 0) + 1);
        counted = true;
      }
      // Per-user caps, keyed by the verified user id, counted when the session is established. The release is bound to this connection's close,
      // which Hocuspocus runs exactly once on every path (client close, error, shutdown); a connection that is already gone is not counted.
      const userId = readContext(data.context).userId;
      if (userId !== undefined && data.connection.document.hasConnection(data.connection)) {
        const admission = accounting.admit(userId, data.socketId);
        if (!admission.ok) {
          // Only the refused document connection closes when the user's other documents on the same socket were admitted; they stay.
          refuse('full-for-you', (socketPages.get(data.socketId) ?? 0) - (counted ? 1 : 0));
          throw limitHit(admission.limit === 'sockets' ? 'user-sockets' : 'user-documents', 'full-for-you', admission.value, admission.max);
        }
        data.connection.onClose(admission.release);
      }
      clearIdle(data.documentName);
      // An editor joining a page that is already past the warning point is told at once; the others were told when it passed.
      const r = record(data.connection.document);
      if (r.warned) data.connection.sendStateless(statelessMessage('warning', 'state-warning'));
      else warnIfOver(data.connection.document, r, data.connection);
    },

    async onDisconnect(data: HookPayloadByName['onDisconnect']): Promise<void> {
      backlogUntil.delete(`${data.socketId}\0${data.documentName}`);
      const sockets = pageSockets.get(data.documentName);
      if (sockets?.delete(data.socketId)) {
        total--;
        if (sockets.size === 0) pageSockets.delete(data.documentName);
        const left = (socketPages.get(data.socketId) ?? 1) - 1;
        if (left > 0) socketPages.set(data.socketId, left);
        else { socketPages.delete(data.socketId); limitedSockets.delete(data.socketId); presenceLogged.delete(data.socketId); void limiter.delete(data.socketId); void presenceLimiter.delete(data.socketId); }
      }
      if (data.clientsCount > 0) return;
      // Safety net behind Hocuspocus's own unload (it unloads at once after the last save): a page that stayed loaded without
      // connections is unloaded after the idle time. `unloadDocument` itself refuses while a save is pending.
      clearIdle(data.documentName);
      const { instance, document } = data;
      const timer = setTimeout(() => {
        idleTimers.delete(data.documentName);
        if (instance.documents.get(data.documentName) === document && document.getConnectionsCount() === 0) {
          instance.unloadDocument(document).catch(() => undefined); // nothing to report: the next disconnect or save tries again
        }
      }, c.idleUnloadSeconds * 1000);
      timer.unref();
      idleTimers.set(data.documentName, timer);
    },

    async afterUnloadDocument(data: HookPayloadByName['afterUnloadDocument']): Promise<void> {
      clearIdle(data.documentName);
    },

    async onDestroy(): Promise<void> {
      for (const t of idleTimers.values()) clearTimeout(t);
      idleTimers.clear();
      for (const t of flushTimers) clearTimeout(t);
      flushTimers.clear();
      accounting.reset();
    },

    /** Every frame of every document connection counts against its socket (R4.18); too many closes the whole socket so the client reconnects and resyncs. */
    async beforeHandleMessage(data: HookPayloadByName['beforeHandleMessage']): Promise<void> {
      const type = messageType(data.update);
      if (type === AWARENESS) {
        // Presence updates have their own budget, applied in `beforeHandleAwareness` by dropping: they never close a socket.
        currentAwareness.set(data.connection, data.update);
        return;
      }
      // A QueryAwareness frame is NOT a presence update (Hocuspocus does not call `beforeHandleAwareness` for it) and makes the server encode and
      // send every state of the page back: it falls through to the user byte budget and the message budget like any other frame.
      const userId = readContext(data.context).userId;
      if (userId !== undefined && !accounting.charge(userId, data.update.byteLength)) {
        // Per-user byte budget across pages: same refusal as the message budget, the document connection closes.
        o.log.emit('collab.limit_hit', { limit: 'user-bytes', value: data.update.byteLength, max: c.bytesPerSecondPerUser, pageId: data.documentName });
        const refusal = refuseMessage(data.connection, 'rate-limited'); // sent first: once the socket is closing the stateless notice is no longer delivered
        data.connection.webSocket.close(SESSION_CLOSE_CODES['rate-limited'], 'rate-limited');
        throw refusal;
      }
      const key = budgetKey(data.context, data.socketId, data.documentName);
      // The 6 s window opens with the first message Hocuspocus handles for this document connection: that is where a reconnect's backlog starts
      // (the hook payloads of `onAuthenticate` do not carry the user yet, this one does).
      const windowKey = `${data.socketId}\0${data.documentName}`;
      if (!backlogUntil.has(windowKey) && key !== data.socketId) backlogUntil.set(windowKey, o.clock.now() + BACKLOG_SECONDS * 1000);
      // A QueryAwareness frame never draws from the reconnect allowance: that is for an offline client's backlog of updates, and a query makes the server
      // encode and send every awareness state of the page (an honest provider sends one when it connects, which the normal budget covers).
      // A sync step 1 request (type 0, subtype 0) is the same: the server answers it with the whole page the client lacks, so it is held to the normal budget too.
      const asksForState = type === QUERY_AWARENESS || (type === 0 && messageSubtype(data.update) === 0);
      if (!asksForState && o.clock.now() < (backlogUntil.get(windowKey) ?? 0)) {
        try { await backlogLimiter.consume(key); return; } catch { /* allowance used up: the budget below applies */ }
      }
      try {
        await limiter.consume(key);
        return;
      } catch {
        // the library rejects with the exhausted counter: that is the refusal
      }
      // The first refused frame of a socket tells the client and logs; the frames still arriving before the close lands only repeat the throw.
      const first = !limitedSockets.has(data.socketId);
      const refusal = first ? refuseMessage(data.connection, 'rate-limited') : new SessionRefusal('rate-limited');
      if (first) {
        limitedSockets.add(data.socketId);
        o.log.emit('collab.limit_hit', { limit: 'message-rate', value: c.messagesPerWindow + 1, max: c.messagesPerWindow, pageId: data.documentName });
      }
      data.connection.webSocket.close(SESSION_CLOSE_CODES['rate-limited'], 'rate-limited');
      throw refusal;
    },

    /** Presence over its budget is dropped here (nothing relayed, nothing closed); the newest dropped update is replayed when the window ends. */
    async beforeHandleAwareness(data: HookPayloadByName['beforeHandleAwareness']): Promise<void> {
      const { connection, document } = data;
      if (connection === undefined) return;
      try {
        await presenceLimiter.consume(data.socketId);
        heldAwareness.delete(connection); // a newer update passed: the held one is stale
        return;
      } catch (res) {
        data.states.clear();
        data.removedClients.clear();
        const frame = currentAwareness.get(connection);
        const wait = (typeof res === 'object' && res !== null && 'msBeforeNext' in res && typeof res.msBeforeNext === 'number' ? res.msBeforeNext : 100) + 5;
        if (frame && !heldAwareness.has(connection)) {
          const timer = setTimeout(() => {
            flushTimers.delete(timer);
            const held = heldAwareness.get(connection);
            heldAwareness.delete(connection);
            if (held && document.hasConnection(connection)) connection.handleMessage(held);
          }, wait);
          timer.unref();
          flushTimers.add(timer);
        }
        if (frame) heldAwareness.set(connection, frame);
        const now = o.clock.now();
        if (now - (presenceLogged.get(data.socketId) ?? 0) >= c.rateWindowSeconds * 1000) {
          presenceLogged.set(data.socketId, now);
          o.log.emit('collab.limit_hit', { limit: 'presence-rate', value: PRESENCE_POINTS + 1, max: PRESENCE_POINTS, pageId: data.documentName });
        }
      }
    },

    /** Runs before each sync message is applied: validates it (R4.17) and keeps the page under the state cap (R4.16). */
    async beforeSync(data: HookPayloadByName['beforeSync']): Promise<void> {
      const { type, payload, document, connection } = data;
      try {
        // Decoding reads every struct without applying anything: bytes that are not a well-formed state vector or update stop here.
        if (type === 0) Y.decodeStateVector(payload);
        else if (type === 1 || type === 2) Y.decodeUpdate(payload);
        else throw new Error('unknown sync message type');
      } catch {
        throw refuseMessage(connection, 'malformed-update');
      }
      if (type === 0 || connection.readOnly) return; // a state vector adds nothing, and a read-only update is never applied

      const r = record(document);
      const n = payload.byteLength;
      let exact = false;
      if (r.bytes + n > c.maxStateBytes) {
        // Near the cap the estimate is replaced by the truth from deltas: one encode of the state merged with the update, no clone, and an
        // update that deletes or overwrites may be large and still shrink the page, so only the result counts.
        const after = estimateAfter(document, payload);
        // A delete-only update adds no content (the merge keeps the deleted text, the real page shrinks), so it always gets through.
        if (after > c.maxStateBytes && Y.decodeUpdate(payload).structs.length > 0) {
          o.log.emit('collab.limit_hit', { limit: 'state-size', value: after, max: c.maxStateBytes, pageId: document.name });
          throw refuseMessage(connection, 'state-cap');
        }
        r.bytes = Math.min(after, c.maxStateBytes);
        exact = true;
      } else {
        r.bytes += n;
      }
      warnIfOver(document, r, undefined, payload, exact);
    },
  };
}
