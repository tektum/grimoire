import { createApiClient } from '@tektum/grimoire-api-client';
import { CLIENT_VERSION } from '../version';
import { type ApiHooks, wrapFetch } from './middleware';

export interface WebApiOptions extends ApiHooks {
  readonly baseUrl: string;
  readonly getToken: () => Promise<string | null>;
  readonly fetch?: (request: Request) => Promise<Response>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly uuid?: () => string;
}

/** The one API client of the app: bearer token, client version header, no cookies, and the error behaviour of `wrapFetch`. */
export function createWebApi(o: WebApiOptions) {
  const base = o.fetch ?? ((request: Request) => fetch(request));
  return createApiClient({
    baseUrl: o.baseUrl,
    getToken: o.getToken,
    clientVersion: CLIENT_VERSION,
    fetch: wrapFetch({ ...o, fetch: base }),
  });
}

/** A 409 `markdown_stale` answer, as a result the caller can match. */
export interface MarkdownStale {
  readonly kind: 'markdown-stale';
}
export interface NotFound {
  readonly kind: 'not-found';
}
export function typedResult(status: number, code: string | undefined, method: string): MarkdownStale | NotFound | null {
  if (status === 409 && code === 'markdown_stale') return { kind: 'markdown-stale' };
  if (method === 'GET' && (status === 404 || status === 403)) return { kind: 'not-found' };
  return null;
}
