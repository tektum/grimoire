import type { Logger } from '@tektum/grimoire-core/ports/logger';

/** Every event the adapter logs, with typed fields: identifiers and numbers only, never tokens, content, headers or messages. */
export interface CollabEvents {
  'server.stats': { level: 'info'; fields: { openUnauthenticated: number } };
  'collab.connected': { level: 'info'; fields: { pageId: string; accessLevel: 'read-write' | 'read-only' } };
  /** `detail`: a fixed string for a user-level refusal (`no-user`, `suspended`); a page refusal never carries one, so the log cannot tell a missing page from a forbidden one either. */
  'collab.refused': { level: 'warn'; fields: { code: string; detail?: RefusalDetail } };
  /** An admission taken at arrival was dropped because its open never reached `connected` in time: the library ended the open without telling us. */
  'collab.admission_expired': { level: 'warn'; fields: { pageId: string } };
  /** The verifier or the database could not answer: the client is told `try-again` and nobody is let in (R4.9). */
  'collab.auth_unavailable': { level: 'error'; fields: { source: 'verifier' | 'database' } };
  /** A connection whose context is not read-write had `readOnly` unset when a message arrived; the host set it before applying anything. A bug alarm. */
  'collab.read_only_mismatch': { level: 'error'; fields: { pageId: string } };
  'collab.store_failed': { level: 'error'; fields: { pageId: string; attempt: number; consecutive: number; retryInMs: number; errorName: string } };
  'collab.store_alarm': { level: 'error'; fields: { pageId: string; consecutive: number } };
  'collab.store_recovered': { level: 'info'; fields: { pageId: string } };
  'collab.store_abandoned': { level: 'error'; fields: { pageId: string } };
  'collab.save_refused_epoch': { level: 'warn'; fields: { pageId: string; loaded: number; reason: 'epoch-mismatch' | 'no-row' } };
  'collab.load_failed': { level: 'warn'; fields: { errorName: string; consecutive: number; suppressed: number } };
  'collab.load_alarm': { level: 'error'; fields: { consecutive: number } };
  'collab.upgrade_failed': { level: 'warn'; fields: { errorName: string; suppressed: number } };
  'collab.upgrade_refused': { level: 'warn'; fields: { reason: 'origin' | 'rate' | 'unauthenticated-sockets' | 'unauthenticated-global'; status: 403 | 429 | 503 } };
  // (saving): identifiers, counts and fixed strings only. Never page text, Markdown, titles or state bytes.
  'collab.seed': { level: 'info'; fields: { pageId: string; bytes: number; ms: number } };
  'collab.seed_failed': { level: 'error'; fields: { pageId: string; reason: string } };
  'collab.saved': { level: 'info'; fields: { pageId: string; stateBytes: number; markdownBytes: number; convertMs: number; writeMs: number } };
  'collab.save_skipped': { level: 'debug'; fields: { pageId: string } };
  /** `kind` tells an operator busy from broken: `busy` = the converter had no room (queue full, waited too long, closing): the state was stored, the page is converted on a later save, no alarm; `broken` = a refusal or a real failure: counts toward `collab.convert_alarm`. */
  'collab.convert_failed': { level: 'warn'; fields: { pageId: string; kind: 'busy' | 'broken'; reason: string; detail: string } };
  'collab.convert_alarm': { level: 'error'; fields: { pageId: string; reason: string } };
  /** Alarm: a page's conversions keep timing out or running out of memory; they stop for `backoffMs` (the state is still stored every time). */
  'collab.convert_breaker_open': { level: 'error'; fields: { pageId: string; failures: number; backoffMs: number } };
  'collab.convert_breaker_closed': { level: 'info'; fields: { pageId: string } };
  'collab.convert_retry': { level: 'info'; fields: { pageId: string; attempt: number; inMs: number } };
  // (limits): counts and identifiers only.
  'collab.limit_hit': { level: 'warn'; fields: { limit: LimitName; value: number; max: number; pageId?: string } };
  'collab.state_warning': { level: 'info'; fields: { pageId: string; stateBytes: number; maxBytes: number } };
  // Summary of the occurrences of one event that were not logged in a window (log-throttle.ts): the event name (not called `event`: that field is the log line's own) and its variant (not `key`: the logger redacts fields of that name), how many, how long the window was.
  // (re-check): ids, counts and fixed strings only.
  'collab.recheck_round': { level: 'debug'; fields: { connections: number; closed: number; ms: number } };
  /** A round could not ask the database: nobody is closed for it until the outage bound is reached (extensions/recheck.ts). */
  'collab.recheck_skipped': { level: 'warn'; fields: { reason: 'database' } };
  'collab.access_closed': { level: 'info'; fields: { pageId: string; reason: AccessClosedReason } };
  'collab.token_sync_failed': { level: 'warn'; fields: { pageId: string; reason: 'invalid' | 'user-mismatch' | 'rate-limited' } };
  'collab.log_suppressed': { level: 'warn'; fields: { suppressedEvent: string; variant: string; count: number; windowSeconds: number } };
}

/** The limit that was reached: `value` is the measured count or size, `max` the configured bound. */
export type LimitName = 'message-size' | 'state-size' | 'message-rate' | 'presence-rate' | 'page-connections' | 'connections' | 'open-documents' | 'memory' | 'user-sockets' | 'user-documents' | 'user-bytes';

/** Why the re-check closed a document connection. `no-access` covers every denial (user gone or suspended, access removed, page or collection gone or trashed): the collapsed answer does not say which (R6.4). */
export type AccessClosedReason = 'no-access' | 'access-changed' | 'epoch' | 'session-expired' | 'recheck-unavailable';

/** Fixed refusal details: no identifiers, no provider messages. */
export type RefusalDetail = 'no-user' | 'suspended';

export interface CollabLog {
  emit<E extends keyof CollabEvents>(event: E, fields: CollabEvents[E]['fields']): void;
}
const LEVELS: { [E in keyof CollabEvents]: CollabEvents[E]['level'] } = {
  'server.stats': 'info',
  'collab.connected': 'info',
  'collab.refused': 'warn',
  'collab.admission_expired': 'warn',
  'collab.auth_unavailable': 'error',
  'collab.read_only_mismatch': 'error',
  'collab.store_failed': 'error',
  'collab.store_alarm': 'error',
  'collab.store_recovered': 'info',
  'collab.store_abandoned': 'error',
  'collab.save_refused_epoch': 'warn',
  'collab.load_failed': 'warn',
  'collab.load_alarm': 'error',
  'collab.upgrade_failed': 'warn',
  'collab.upgrade_refused': 'warn',
  'collab.limit_hit': 'warn',
  'collab.state_warning': 'info',
  'collab.seed': 'info',
  'collab.seed_failed': 'error',
  'collab.saved': 'info',
  'collab.save_skipped': 'debug',
  'collab.convert_failed': 'warn',
  'collab.convert_alarm': 'error',
  'collab.convert_breaker_open': 'error',
  'collab.convert_breaker_closed': 'info',
  'collab.convert_retry': 'info',
  'collab.recheck_round': 'debug',
  'collab.recheck_skipped': 'warn',
  'collab.access_closed': 'info',
  'collab.token_sync_failed': 'warn',
  'collab.log_suppressed': 'warn',
};

export function createCollabLog(logger: Logger): CollabLog {
  return {
    // The one non-literal event name in the adapter: the level table above keeps it typed.
    emit: (event, fields) => { logger[LEVELS[event]](event, fields); },
  };
}
