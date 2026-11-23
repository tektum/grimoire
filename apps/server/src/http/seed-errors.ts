import type { SeedRefusal } from '@tektum/grimoire-core/pages/seeded-content';
import type { ErrorCode } from './error.js';

export interface HttpRefusal {
  readonly code: ErrorCode;
  readonly message?: string;
  readonly headers?: Record<string, string>;
}

const BUSY = 'The converter is busy with other pages. Try again in a moment.';
const BUSY_HEADERS = { 'retry-after': '5' };

/**
 * The one place a refusal becomes an answer. `no-key` is a bug (the route forgot the key): it is a 503, and the 5xx handler
 * logs `http.handler_error` for it. Feed the result to `fail(code, message, headers)`.
 */
export function seedRefusalToHttp(r: Pick<SeedRefusal, 'stage' | 'reason' | 'detail' | 'message'>): HttpRefusal {
  if (r.stage === 'convert') {
    // A good seed whose state cannot be written back: the document is the problem, unless the converter itself failed.
    if (r.reason === 'content-lost' || r.reason === 'too-large' || r.reason === 'too-deep' || r.reason === 'invalid-state') {
      return { code: 'invalid', message: r.message ?? 'The Markdown cannot be converted.' };
    }
    if (r.reason === 'timeout') return { code: 'unavailable', message: BUSY, headers: BUSY_HEADERS };
    return { code: 'unavailable', message: BUSY, headers: BUSY_HEADERS };
  }
  switch (r.reason) {
    case 'invalid-markdown':
      return { code: 'invalid', message: r.message ?? 'The Markdown is not valid.' };
    case 'too-large':
      // The real pool puts the limit sentence (counts only, never text) in `detail` for a seed over a limit.
      return { code: 'invalid', message: r.message ?? r.detail };
    case 'timeout':
      // The pool's time limit also covers the wait for a worker, so a timeout does not show the page is at fault: retryable.
      return { code: 'unavailable', message: BUSY, headers: BUSY_HEADERS };
    default:
      if (r.detail === 'one-at-a-time') {
        return { code: 'rate_limited', message: 'Another conversion is still running. Try again in a moment.', headers: { 'retry-after': '2' } };
      }
      return { code: 'unavailable', message: BUSY, headers: BUSY_HEADERS };
  }
}
