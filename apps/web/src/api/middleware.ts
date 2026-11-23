import { log } from '../logging';
import { FALLBACK_MESSAGE, messageFor, rateLimitedMessage } from './messages';

export type SignOutReason = 'expired' | 'suspended' | 'not-allowed';
export interface ApiHooks {
  /** One refresh; false means sign in again. */
  refresh(): Promise<boolean>;
  signOut(reason: SignOutReason): void | Promise<void>;
  /** A notice for the user (a toast). `retry` is set when the notice has a "Try again" button. */
  notify(text: string): void;
  /** Called when the server says this client is too old. */
  reload(): void;
}
export interface WrapOptions extends ApiHooks {
  fetch: (request: Request) => Promise<Response>;
  /** The current token; read again after a refresh so the retry carries the new one. */
  getToken?: () => Promise<string | null>;
  sleep?: (ms: number) => Promise<void>;
  uuid?: () => string;
}

/** Operations that accept an `Idempotency-Key` (the `idem:yes` operations of docs/api-surface.txt). */
export const IDEMPOTENT: readonly { method: string; path: RegExp }[] = [
  { method: 'POST', path: /^\/v1\/collections$/ },
  { method: 'POST', path: /^\/v1\/groups$/ },
  { method: 'POST', path: /^\/v1\/pages$/ },
  { method: 'POST', path: /^\/v1\/pages\/[^/]+\/reset-state$/ },
];
export const isIdempotent = (method: string, pathname: string): boolean => IDEMPOTENT.some((o) => o.method === method && o.path.test(pathname));

const MAX_RETRIES = 3;
const MAX_WAIT_S = 30;
const BACKOFF_S = [1, 2, 4];
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function errorCode(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.clone().json();
    const code = (body as { error?: { code?: unknown } })?.error?.code ?? (body as { code?: unknown })?.code;
    return typeof code === 'string' ? code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Wraps `fetch` with the behaviour every call gets: credentials omitted, a UUID idempotency key on idempotent operations (kept across retries),
 * one refresh after a 401, `Retry-After` retries, backoff on 503 and network failures for reads, and the notices and sign-outs of the error table.
 * The response is returned for the caller to read (typed results such as NotFound and MarkdownStale come from the status and code).
 */
export function wrapFetch(o: WrapOptions): (request: Request) => Promise<Response> {
  const sleep = o.sleep ?? defaultSleep;
  const uuid = o.uuid ?? (() => crypto.randomUUID());
  return async (request) => {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const idem = isIdempotent(method, url.pathname);
    const retryable = method === 'GET' || idem;
    if (idem && !request.headers.has('Idempotency-Key')) request.headers.set('Idempotency-Key', uuid());
    let refreshed = false;
    for (let attempt = 0; ; attempt += 1) {
      const send = new Request(request.clone(), { credentials: 'omit' });
      let response: Response;
      try {
        response = await o.fetch(send);
      } catch (error) {
        if (method === 'GET' && attempt < MAX_RETRIES) {
          await sleep((BACKOFF_S[attempt] ?? 4) * 1000);
          continue;
        }
        log('warn', 'web.api_error', { status: 0, code: 'network' });
        o.notify(messageFor('unavailable'));
        throw error;
      }
      if (response.ok) return response;
      const code = await errorCode(response);
      if (response.status === 401 && !refreshed) {
        refreshed = true;
        if (await o.refresh()) {
          const token = await o.getToken?.();
          if (token) request.headers.set('Authorization', `Bearer ${token}`);
          continue;
        }
      }
      if (response.status === 401) {
        await o.signOut('expired');
        return response;
      }
      if (response.status === 403 && code === 'account_suspended') {
        await o.signOut('suspended');
        return response;
      }
      if (response.status === 403 && code === 'not_allowed') {
        await o.signOut('not-allowed');
        return response;
      }
      if (response.status === 426 || code === 'client_too_old') {
        o.reload();
        return response;
      }
      if (response.status === 429) {
        const seconds = Math.min(MAX_WAIT_S, Math.max(0, Number(response.headers.get('Retry-After')) || 1));
        if (retryable && attempt < MAX_RETRIES) {
          o.notify(rateLimitedMessage(seconds));
          await sleep(seconds * 1000);
          continue;
        }
        o.notify(rateLimitedMessage(seconds));
        return response;
      }
      if (response.status === 503) {
        if (retryable && attempt < MAX_RETRIES) {
          await sleep((BACKOFF_S[attempt] ?? 4) * 1000);
          continue;
        }
        o.notify(messageFor('unavailable'));
        return response;
      }
      reportOther(response.status, code, method, o.notify);
      return response;
    }
  };
}

/** Notices for the answers a screen does not handle itself. Reads of a page or collection (404/403) are the screen's not-found, with no notice. */
function reportOther(status: number, code: string | undefined, method: string, notify: (t: string) => void): void {
  if (method === 'GET' && (status === 404 || status === 403)) return;
  if (status === 409 && code === 'markdown_stale') return; // a typed result: the caller offers a reload
  const known =
    code !== undefined &&
    code in
      {
        would_create_cycle: 1,
        too_deep: 1,
        collection_full: 1,
        collection_deleted: 1,
        name_taken: 1,
        last_admin: 1,
        save_failed: 1,
        conflict: 1,
        too_large: 1,
        type_not_allowed: 1,
        type_mismatch: 1,
        upload_missing: 1,
        size_mismatch: 1,
        invalid: 1,
        forbidden: 1,
      };
  if (!known) log('error', 'web.api_error', { status, code: code ?? null });
  notify(status === 403 && code === 'forbidden' ? messageFor('forbidden') : known ? messageFor(code) : FALLBACK_MESSAGE);
}
