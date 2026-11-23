import type { RefusalDetail } from './events.js';

/** Close codes by refusal reason: the single source. Reasons are plain strings so later tasks add their own (pass `refusals` to `createCollabHost`). */
export type RefusalTable = Readonly<Record<string, number>>;

export const REFUSAL_CLOSE_CODES: RefusalTable = {
  'bad-document-name': 4400,
  'invalid-token': 4401,
  'forbidden': 4403,
  'not-found': 4404,
  'page-full': 4413,
  'server-full': 4503,
  'documents-full': 4503,
  'memory-guard': 4503,
  'full-for-you': 4503,
  'preauth-timeout': 4408,
  'try-again': 4503,
  // The stored state cannot be applied, or a hook failed in an unexpected way: the document is not opened, nothing is written.
  'state-corrupt': 4500,
  // Not retryable: the stored Markdown cannot become a document. The web client (the web client, planned) must NOT reconnect automatically on 4501; the refusal repeats until the Markdown changes.
  'seed-failed': 4501,
  'internal-error': 4500,
  // The client's recorded state epoch differs from the page's (a reset or a restore): it must reload the page, not merge.
  'stale-epoch': 4409,
  // The client is older than the minimum, or sent no handshake while one is required: it must update.
  'client-too-old': 4426,
};
/** In-session closes of the re-check (contracts section 7): the document connection is closed, the socket and its other documents stay. */
export const SESSION_CLOSES = { 'access-changed': 4205, 'session-expired': 4401 } as const;

/** Code for a reason that is in no table (a bug in the caller, never a reason to leave a socket open). 4429 stays reserved for rate limiting (T10), and 4408 for Hocuspocus. */
export const FALLBACK_REFUSAL_CODE = 4500;

export const REFUSAL_REASONS: readonly string[] = Object.keys(REFUSAL_CLOSE_CODES);

export const codeFor = (table: RefusalTable, reason: string): number => table[reason] ?? FALLBACK_REFUSAL_CODE;

/** Standard WebSocket "going away", sent to every socket on shutdown. */
export const GOING_AWAY = { code: 1001, reason: 'going away' } as const;

/** Throw from a connect-time hook to refuse with `reason`; Hocuspocus turns it into `permission-denied`. The message stays empty so the library does not log it. */
export class Refusal extends Error {
  readonly reason: string;
  /** A fixed string for the log line only (never sent to the client): which user-level check refused. */
  readonly detail: RefusalDetail | undefined;
  constructor(reason: string, detail?: RefusalDetail) {
    super('');
    this.reason = reason;
    this.detail = detail;
  }
}
