import type { CollabEvents, CollabLog } from './events.js';

/**
 * Which events a client without credentials, or a flooding one, can trigger again and again, and the field that names the kind of occurrence
 * (an enumerated value, never an address, token or content). Everything else is rare or alarm-class and is always logged:
 *
 * | event | who can trigger it | policy |
 * |---|---|---|
 * | collab.upgrade_refused | anyone, unauthenticated, once per upgrade | one line per reason per window + count |
 * | collab.refused | anyone (bad token, name, a limit), every message of a flooder | one line per code per window + count |
 * | collab.limit_hit | anyone reaching a limit | one line per limit per window + count |
 * | collab.auth_unavailable | anyone connecting while the verifier is down | one line per window + count |
 * | collab.state_warning | an editor, once per loaded page | one line per page per window + count |
 * | collab.recheck_skipped | the database being down, once per round | one line per window + count |
 * | collab.token_sync_failed | a client presenting bad tokens on an open connection | one line per reason per window + count |
 * | collab.connected | a user with a valid token, bounded by the connection caps | first 10 per window + count |
 * | collab.store_failed | a page being stored, at its retry backoff (at most the open documents) | always |
 * | collab.store_alarm, store_recovered, store_abandoned | server state, once per streak or page | always, never throttled |
 * | collab.log_suppressed | this module | always |
 */
const KEY_FIELD: Partial<Record<keyof CollabEvents, string | null>> = {
  'collab.upgrade_refused': 'reason',
  'collab.refused': 'code',
  'collab.limit_hit': 'limit',
  'collab.auth_unavailable': null,
  'collab.state_warning': 'pageId',
  'collab.connected': null,
  'collab.recheck_skipped': null,
  'collab.token_sync_failed': 'reason',
  'collab.seed_failed': 'pageId',
  'collab.admission_expired': 'pageId',
};

/** Lines let through before the counting starts, per event (default 1): a handful of users arriving together is information, a reconnect storm is not. */
const BURST: Partial<Record<keyof CollabEvents, number>> = { 'collab.connected': 10 };

export interface ThrottleOptions {
  /** Length of a window; default 10 s. */
  readonly windowMs?: number;
  /** Most keys tracked at once; default 1,000. Beyond it occurrences of new keys are only counted, into one summary line per window. */
  readonly maxKeys?: number;
}

export interface ThrottledLog extends CollabLog {
  /** Keys tracked right now (bounded by `maxKeys`), for tests. */
  trackedKeys(): number;
}

interface Slot { logged: number; suppressed: number; timer: NodeJS.Timeout }

const OVERFLOW = '*';

/**
 * The first occurrence of an event kind in a window is logged at once; the rest of the window is counted and one `collab.log_suppressed` line
 * with the count follows when the window ends, so a flood costs two lines per kind per window. Not `rate-limiter-flexible`: it can say
 * allow or deny, but it cannot hand over the number of denied calls or fire at the end of the window, which the summary needs.
 * Memory: at most `maxKeys` slots (each a counter and an unref'd timer) plus one overflow slot; a slot lives for one window.
 */
export function throttleLog(inner: CollabLog, options: ThrottleOptions = {}): ThrottledLog {
  const windowMs = options.windowMs ?? 10_000;
  const maxKeys = options.maxKeys ?? 1000;
  const slots = new Map<string, Slot>();

  const open = (id: string, event: string, key: string): Slot => {
    const slot: Slot = {
      logged: 1,
      suppressed: 0,
      timer: setTimeout(() => {
        slots.delete(id);
        if (slot.suppressed > 0) inner.emit('collab.log_suppressed', { suppressedEvent: event, variant: key, count: slot.suppressed, windowSeconds: windowMs / 1000 });
      }, windowMs),
    };
    slot.timer.unref();
    slots.set(id, slot);
    return slot;
  };

  return {
    trackedKeys: () => slots.size,
    emit(event, fields) {
      const keyField = KEY_FIELD[event];
      if (keyField === undefined) { inner.emit(event, fields); return; }
      const raw = keyField === null ? '' : (fields as Record<string, unknown>)[keyField];
      const key = typeof raw === 'string' ? raw : '';
      const id = `${event}\0${key}`;
      const slot = slots.get(id);
      if (slot) {
        if (slot.logged < (BURST[event] ?? 1)) { slot.logged++; inner.emit(event, fields); } else slot.suppressed++;
        return;
      }
      if (slots.size < maxKeys) { open(id, event, key); inner.emit(event, fields); return; }
      // Too many kinds at once: count into one shared slot instead of tracking each.
      const shared = slots.get(OVERFLOW) ?? open(OVERFLOW, '*', 'overflow');
      shared.suppressed++;
    },
  };
}
