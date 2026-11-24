// What the provider shows and does for each signal the server can give (contracts section 6, the table). Behaviour is chosen by the reason string; the code
// is the fallback for a proxy or a test server that shows only the code. One table, one function, and a test over every row.

export type Behaviour =
  | 'RETRY' // keep the document, reconnect with growing delay
  | 'FRESH' // destroy editor, provider and document and create new ones for the same page
  | 'REFRESH' // refresh the session, then RETRY; a second refusal for the same cause within a minute is SIGN_OUT
  | 'SIGN_OUT'
  | 'NO_ACCESS'
  | 'NOT_FOUND'
  | 'LARGE' // read-only, stops sending
  | 'BUSY' // RETRY with a longer minimum delay
  | 'ERROR' // retry in 30 s, three times, then a button; or no retry at all
  | 'RELOAD' // stop reconnecting
  | 'TOKEN' // the session token could not be had: try the token again in 5 s
  | 'NOTICE' // a message, the connection stays
  | 'BANNER' // a standing message
  | 'READ_ONLY'
  | 'LOG' // logged only
  | 'EPOCH' // the page's state epoch, to record at `synced`
  | 'IGNORE';

export interface Mapping {
  readonly behaviour: Behaviour;
  readonly text?: string;
  /** The earliest the next attempt may be, in ms (BUSY, upgrade-style failures). */
  readonly minDelayMs?: number;
  /** ERROR only: never retried by itself; a message and a button. */
  readonly noRetry?: boolean;
  /** FRESH only: the page was reset, so the tab offers the user a copy of what it held. */
  readonly offerCopy?: boolean;
  /** The event to log (ids only, never text). */
  readonly log?: string;
  readonly epoch?: number;
}

export type Signal =
  | { readonly type: 'authenticationFailed'; readonly reason: string }
  | { readonly type: 'close'; readonly code: number; readonly reason?: string }
  | { readonly type: 'stateless'; readonly payload: string }
  | { readonly type: 'scope'; readonly readOnly: boolean };

export const TEXTS = {
  badDocumentName: 'Something went wrong opening this page. Reload.',
  noAccess: 'You no longer have access to this page',
  pageFull: 'This page already has 100 people editing. Try again in a moment.',
  busy: 'The server is busy. Trying again.',
  cannotOpen: "This page can't be opened right now. Trying again.",
  rateLimited: 'You are sending changes faster than the server accepts. Trying again.',
  rateLimitedNotice: 'You are sending changes faster than the server accepts.',
  tooLarge: 'This page is too large to edit further. You can still read it.',
  stateWarning: 'This page is close to its size limit.',
  tooOld: 'A new version is available. Reload.',
  reset: 'This page was reset. Your unsent changes were not applied.',
  signInUnavailable: 'Sign-in is unavailable. Trying again.',
  readOnly: 'Read only',
  offline: 'Offline: changes kept in this tab',
} as const;

/** The provider's own text when the token function failed: `Failed to get token during sendToken(): ...`. */
const TOKEN_FAILED_PREFIX = 'Failed to get token';
const BUSY_MS = 10_000;
const RATE_LIMIT_MS = 30_000;
const UPGRADE_FAILURE_MS = 2_000;

const fresh = (extra: Partial<Mapping> = {}): Mapping => ({ behaviour: 'FRESH', ...extra });
const retry = (minDelayMs?: number): Mapping => ({ behaviour: 'RETRY', ...(minDelayMs === undefined ? {} : { minDelayMs }) });
const error = (text: string, extra: Partial<Mapping> = {}): Mapping => ({ behaviour: 'ERROR', text, log: 'web.collab_error', ...extra });

/** A refusal at connect time, by its reason string. An unknown reason is an ERROR. */
function byReason(reason: string): Mapping {
  switch (reason) {
    case 'bad-document-name':
      return error(TEXTS.badDocumentName, { noRetry: true });
    case 'invalid-token':
      return { behaviour: 'REFRESH' };
    case 'forbidden':
      return { behaviour: 'NO_ACCESS', text: TEXTS.noAccess };
    case 'not-found':
      return { behaviour: 'NOT_FOUND' };
    case 'page-full':
      return { behaviour: 'BUSY', text: TEXTS.pageFull, minDelayMs: BUSY_MS };
    case 'server-full':
    case 'documents-full':
    case 'memory-guard':
    case 'full-for-you':
    case 'try-again':
      return { behaviour: 'BUSY', text: TEXTS.busy, minDelayMs: BUSY_MS };
    case 'preauth-timeout':
      return retry();
    case 'seed-failed':
      return error(TEXTS.cannotOpen, { noRetry: true });
    case 'state-corrupt':
    case 'internal-error':
      return error(TEXTS.cannotOpen);
    case 'stale-epoch':
      return fresh({ offerCopy: true, text: TEXTS.reset });
    case 'client-too-old':
      return { behaviour: 'RELOAD', text: TEXTS.tooOld };
    default:
      // The provider's own text for a token function that failed: the sign-in service is unavailable, not the server.
      if (reason.startsWith(TOKEN_FAILED_PREFIX)) return { behaviour: 'TOKEN', text: TEXTS.signInUnavailable };
      return error(TEXTS.cannotOpen);
  }
}

/** A close, by its reason string first, then by code (a proxy or a test server can show a code the provider reports as 1000). */
function byClose(code: number, reason: string | undefined): Mapping {
  if (reason === 'access-changed' || code === 4205) return fresh();
  if (reason === 'session-expired') return { behaviour: 'REFRESH' };
  if (reason === 'stale-epoch' || code === 4409) return fresh({ offerCopy: true, text: TEXTS.reset });
  if (reason === 'rate-limited' || code === 4429) return { behaviour: 'BUSY', text: TEXTS.rateLimited, minDelayMs: RATE_LIMIT_MS };
  if (code === 1009) return { behaviour: 'LARGE', text: TEXTS.tooLarge };
  if (code === 4422) return fresh({ log: 'web.collab_malformed' });
  if (code === 4501) return byReason('seed-failed');
  if (code === 4500) return byReason('state-corrupt');
  if (code === 4426) return byReason('client-too-old');
  if (code === 4413) return byReason('page-full');
  if (code === 4503) return byReason('try-again');
  if (code === 4400) return byReason('bad-document-name');
  if (code === 4401) return byReason('invalid-token');
  if (code === 4403) return byReason('forbidden');
  if (code === 4404) return byReason('not-found');
  // 1006 with no reason is what a refusal at the upgrade (an address limit, a 403, 404, 429 or 503) looks like to a browser: retry, not faster than two seconds.
  if (code === 1006 && (reason === undefined || reason === '')) return retry(UPGRADE_FAILURE_MS);
  return retry();
}

function byStateless(payload: string): Mapping {
  let message: unknown;
  try {
    message = JSON.parse(payload);
  } catch {
    return { behaviour: 'IGNORE' };
  }
  if (typeof message !== 'object' || message === null) return { behaviour: 'IGNORE' };
  const m = message as { grimoire?: unknown; kind?: unknown; code?: unknown; epoch?: unknown };
  if (m.grimoire !== 1) return { behaviour: 'IGNORE' };
  if (m.kind === 'epoch') return typeof m.epoch === 'number' && Number.isInteger(m.epoch) && m.epoch >= 0 ? { behaviour: 'EPOCH', epoch: m.epoch } : { behaviour: 'IGNORE' };
  if (m.kind === 'warning') return m.code === 'state-warning' ? { behaviour: 'BANNER', text: TEXTS.stateWarning } : { behaviour: 'IGNORE' };
  if (m.kind !== 'refusal') return { behaviour: 'IGNORE' };
  switch (m.code) {
    case 'rate-limited':
      return { behaviour: 'NOTICE', text: TEXTS.rateLimitedNotice };
    case 'state-cap':
      return { behaviour: 'LARGE', text: TEXTS.tooLarge };
    case 'malformed-update':
      return fresh({ log: 'web.collab_malformed' });
    case 'presence-violation':
      return { behaviour: 'LOG', log: 'web.collab_presence' };
    case 'stale-epoch':
      return fresh({ offerCopy: true, text: TEXTS.reset });
    default:
      return { behaviour: 'LOG', log: 'web.collab_refusal' };
  }
}

export function mapSignal(signal: Signal): Mapping {
  switch (signal.type) {
    case 'authenticationFailed':
      return byReason(signal.reason);
    case 'close':
      return byClose(signal.code, signal.reason);
    case 'stateless':
      return byStateless(signal.payload);
    case 'scope':
      return signal.readOnly ? { behaviour: 'READ_ONLY', text: TEXTS.readOnly } : { behaviour: 'IGNORE' };
  }
}
