import type { Document, Extension, HookPayloadByName } from '@hocuspocus/server';
import * as Y from 'yjs';
import { readContext } from '../context.js';

/** The stateless message the sender gets for a dropped presence update (contracts section 6). */
export const PRESENCE_VIOLATION = JSON.stringify({ grimoire: 1, kind: 'refusal', code: 'presence-violation' });

const asRecord = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? Object.fromEntries(Object.entries(v)) : {});

/** Honest states measure 300 to 530 bytes (cursor, long selection, 200-character name); 4 KiB leaves room, and stops one client fanning megabytes out per update. */
export const AWARENESS_STATE_MAX_BYTES = 4096;
const encoder = new TextEncoder();

interface Bindings {
  /** Yjs client id -> the socket that owns it (first publisher wins). */
  readonly owner: Map<number, string>;
  /** Socket -> the one client id it owns. */
  readonly owned: Map<string, number>;
  /** Yjs client id -> the socket whose first document update carried it: that proof beats an awareness claim, which anyone can make first. */
  readonly bound: Map<number, string>;
}

/**
 * Awareness identity (R4.12), in `beforeHandleAwareness`: the hook sees the decoded update before it is applied and broadcast, and
 * deleting from `states` or `removedClients` drops an entry. A socket owns the first client id it publishes and no other; a foreign
 * or second id, a foreign removal and a state whose `user.id` is not the authenticated user are dropped and the sender is told.
 * A state without `user.id` gets the authenticated one. Display name and colour are not checked (R14.11).
 */
export function createPresenceExtension(): Extension {
  // Per document (a socket's identity is the same on every document, ownership is not); keyed by socketId because
  // `onDisconnect` has no Connection, only the socket id.
  const books = new WeakMap<Document, Bindings>();
  const bookFor = (doc: Document): Bindings => {
    let b = books.get(doc);
    if (!b) { b = { owner: new Map(), owned: new Map(), bound: new Map() }; books.set(doc, b); }
    return b;
  };

  return {
    extensionName: 'grimoire-presence',
    priority: 600,

    async beforeHandleAwareness(data: HookPayloadByName['beforeHandleAwareness']): Promise<void> {
      const { connection, states, removedClients } = data;
      if (connection === undefined) return; // server-side origin
      const userId = readContext(data.context).userId;
      const book = bookFor(data.document);
      const socket = data.socketId;
      let violation = false;
      const drop = (id: number): void => { states.delete(id); removedClients.delete(id); violation = true; };
      const forgetOwnership = (id: number): void => { const o = book.owner.get(id); book.owner.delete(id); if (o !== undefined && book.owned.get(o) === id) book.owned.delete(o); };

      if (userId === undefined) {
        // Not authenticated: nothing can be attributed, so nothing is published.
        for (const id of [...states.keys(), ...removedClients]) drop(id);
      } else {
        for (const id of [...removedClients]) {
          const owner = book.owner.get(id);
          if (owner !== undefined && owner !== socket) drop(id); // a removal of someone else's state
          else if (owner === undefined && !book.owned.has(socket)) drop(id); // an id nobody published
        }
        for (const [id, state] of [...states]) {
          if (encoder.encode(JSON.stringify(state)).byteLength > AWARENESS_STATE_MAX_BYTES) { drop(id); continue; }
          const proven = book.bound.get(id);
          if (proven !== undefined && proven !== socket) { drop(id); continue; } // the id belongs to the socket that wrote with it
          if (proven === socket && book.owner.get(id) !== socket) forgetOwnership(id); // a squatter's earlier claim is void
          const owner = book.owner.get(id);
          const mine = book.owned.get(socket);
          if (owner !== undefined && owner !== socket) { drop(id); continue; }
          if (owner === undefined && mine !== undefined && mine !== id) { drop(id); continue; }
          const base = asRecord(state);
          const baseUser = asRecord(base['user']);
          const claimed = baseUser['id'];
          if (claimed !== undefined && claimed !== userId) { drop(id); continue; }
          if (owner === undefined) { book.owner.set(id, socket); book.owned.set(socket, id); }
          states.set(id, { ...base, user: { ...baseUser, id: userId } });
        }
        for (const id of removedClients) {
          if (book.owner.get(id) === socket) { book.owner.delete(id); book.owned.delete(socket); }
        }
      }
      if (violation) connection.sendStateless(PRESENCE_VIOLATION);
    },

    /** The first document update of a socket binds the one client id it writes with; decoding reads the structs without applying anything. */
    async beforeSync(data: HookPayloadByName['beforeSync']): Promise<void> {
      if (data.type !== 2 || data.connection.readOnly || readContext(data.context).userId === undefined) return;
      const book = bookFor(data.document);
      const socket = data.connection.socketId;
      if ([...book.bound.values()].includes(socket)) return;
      let ids: Set<number>;
      try { ids = new Set(Y.decodeUpdate(data.payload).structs.map((st) => st.id.client)); } catch { return; } // the limits extension refuses malformed updates
      const [id] = ids;
      if (ids.size !== 1 || id === undefined || book.bound.has(id)) return; // an update that is not one client's own work proves nothing
      const owner = book.owner.get(id);
      if (owner !== undefined && owner !== socket) { book.owner.delete(id); if (book.owned.get(owner) === id) book.owned.delete(owner); }
      const earlier = book.owned.get(socket);
      if (earlier !== undefined && earlier !== id) book.owner.delete(earlier);
      book.bound.set(id, socket);
      book.owner.set(id, socket);
      book.owned.set(socket, id);
    },

    async onDisconnect(data: HookPayloadByName['onDisconnect']): Promise<void> {
      const book = books.get(data.document);
      if (!book) return;
      const id = book.owned.get(data.socketId);
      if (id !== undefined) { book.owner.delete(id); book.owned.delete(data.socketId); }
      for (const [clientId, socket] of book.bound) if (socket === data.socketId) book.bound.delete(clientId);
    },
  };
}
