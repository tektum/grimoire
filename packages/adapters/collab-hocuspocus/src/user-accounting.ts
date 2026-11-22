import type { Clock } from '@tektum/grimoire-core/ports/clock';

/**
 * Per-user accounting. Every key is the SERVER-VERIFIED user id (from the token verifier), never anything the client sends.
 * An admitted session (one authenticated document on one socket) returns its own `release`, which is idempotent: the caller wires it to
 * the connection's close, so every count that went up comes down exactly once on every path (close, error, shutdown).
 * No timers: byte windows of users with no session left are swept on the next call.
 */
export interface UserCaps {
  /** Distinct sockets with at least one session. */
  readonly sockets: number;
  /** Sessions (documents on sockets); two sessions on one document count as two. */
  readonly documents: number;
  /** Bytes per user per window, across all pages. */
  readonly bytesPerWindow: number;
  readonly windowMs: number;
}

export type Admission =
  | { readonly ok: true; readonly release: () => void }
  | { readonly ok: false; readonly limit: 'sockets' | 'documents'; readonly value: number; readonly max: number };

interface Window { start: number; bytes: number }
interface UserEntry {
  sessions: number;
  /** Socket id -> sessions on it. */
  readonly sockets: Map<string, number>;
  window: Window | undefined;
}

export interface UserAccounting {
  admit(userId: string, socketId: string): Admission;
  /** Charges `bytes` to the user's current window; false (and nothing charged) when it would pass the budget. */
  charge(userId: string, bytes: number): boolean;
  counts(): { users: number; sockets: number; documents: number; windows: number };
  /** Drops everything (host destroy); late releases are then no-ops. */
  reset(): void;
}

export function createUserAccounting(caps: UserCaps, clock: Clock): UserAccounting {
  let users = new Map<string, UserEntry>();
  /** Windows of users with no session left, kept until they expire so reconnecting does not renew a budget. */
  let lingering = new Map<string, Window>();
  let generation = 0;

  const sweep = (now: number): void => {
    for (const [id, w] of lingering) if (now - w.start >= caps.windowMs) lingering.delete(id);
  };

  return {
    admit(userId, socketId) {
      const entry = users.get(userId);
      const onSocket = entry?.sockets.get(socketId) ?? 0;
      if (onSocket === 0 && (entry?.sockets.size ?? 0) >= caps.sockets) return { ok: false, limit: 'sockets', value: entry?.sockets.size ?? 0, max: caps.sockets };
      if ((entry?.sessions ?? 0) >= caps.documents) return { ok: false, limit: 'documents', value: entry?.sessions ?? 0, max: caps.documents };
      const now = clock.now();
      sweep(now);
      const mine: UserEntry = entry ?? { sessions: 0, sockets: new Map(), window: lingering.get(userId) };
      lingering.delete(userId);
      mine.sessions++;
      mine.sockets.set(socketId, onSocket + 1);
      users.set(userId, mine);
      const born = generation;
      let released = false;
      return {
        ok: true,
        release: () => {
          if (released) return;
          released = true;
          if (born !== generation) return;
          const e = users.get(userId);
          if (!e) return;
          e.sessions--;
          const left = (e.sockets.get(socketId) ?? 1) - 1;
          if (left > 0) e.sockets.set(socketId, left); else e.sockets.delete(socketId);
          if (e.sessions > 0) return;
          users.delete(userId);
          const t = clock.now();
          sweep(t);
          if (e.window && t - e.window.start < caps.windowMs) lingering.set(userId, e.window);
        },
      };
    },

    charge(userId, bytes) {
      const e = users.get(userId);
      if (!e) return true; // no session: nothing of this user is accounted (never reached after authentication)
      const now = clock.now();
      if (!e.window || now - e.window.start >= caps.windowMs) e.window = { start: now, bytes: 0 };
      if (e.window.bytes + bytes > caps.bytesPerWindow) return false;
      e.window.bytes += bytes;
      return true;
    },

    counts() {
      let sockets = 0; let documents = 0;
      for (const e of users.values()) { sockets += e.sockets.size; documents += e.sessions; }
      return { users: users.size, sockets, documents, windows: lingering.size };
    },

    reset() {
      generation++;
      users = new Map();
      lingering = new Map();
    },
  };
}
