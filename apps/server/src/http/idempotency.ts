import { createHash } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { routePath } from 'hono/route';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { StoredResponse } from '@tektum/grimoire-core/ports/idempotency-store';
import { fail } from './error.js';
import { routeExtension } from './rate-limit.js';
import type { AppEnv, HttpDeps } from './env.js';

/**
 * A route's own answer to a replay, instead of the stored one: it gets the stored status and body and returns the response to send.
 * A route registers it under `"METHOD /route/{pattern}"` (the pattern as `routePath` reports it, with `:id` for parameters). It may
 * raise an `ApiError` (`fail`) to refuse the replay.
 */
export type ReplayRebuild = (stored: StoredResponse, c: Context<AppEnv>) => Response | Promise<Response>;

export interface IdempotencyOptions {
  /** Per-route replay hooks; a route without one replays the stored status and body as they were. */
  readonly rebuild?: Readonly<Record<string, ReplayRebuild>>;
  /** Per-route stored form, by `"METHOD /route/pattern"`: what is kept of a 2xx JSON body (a signed URL is never stored; the route's replay hook makes a new one). */
  readonly stored?: Readonly<Record<string, (body: unknown) => unknown>>;
  /** True for about one request in a hundred: that request also deletes the keys older than a day. */
  readonly sample?: () => boolean;
}

const KEY = /^[\x21-\x7e]{1,255}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

const plain = (stored: StoredResponse): Response => (stored.body === null
  ? new Response(null, { status: stored.status })
  : new Response(JSON.stringify(stored.body), { status: stored.status, headers: { 'content-type': 'application/json' } }));

/**
 * `Idempotency-Key` on the routes declared `idempotent: true` (R6.7). The first request with a key claims `(user, key)` with the hash of
 * its method, path, query and body and runs. The same key and hash after it finished replays its status and body with
 * `Idempotent-Replay: true`; the same key with another hash, or while the first request still runs, is 409 `conflict`. Only a 2xx JSON
 * answer is kept: any other outcome frees the key, so a request refused for a mistake can be sent again with the same key.
 */
export function idempotency(app: OpenAPIHono<AppEnv>, deps: Pick<HttpDeps, 'idempotency' | 'clock' | 'log'>, opts: IdempotencyOptions): MiddlewareHandler<AppEnv> {
  const declared = routeExtension<boolean>(app, 'x-grimoire-idempotent');
  const sample = opts.sample ?? ((): boolean => Math.random() < 0.01);
  return async (c, next) => {
    const method = c.req.method;
    if (SAFE.has(method)) return next();
    const pattern = routePath(c, -1);
    const key = c.req.header('idempotency-key');
    const userId = c.get('user')?.id;
    if (key === undefined || userId === undefined || declared(method, pattern) !== true) return next();
    if (!KEY.test(key)) return fail('invalid');

    if (sample()) {
      // Housekeeping must never delay or fail the request that happened to be picked.
      void deps.idempotency.deleteCreatedBefore(deps.clock.now() - DAY_MS).catch(() => undefined);
    }
    const hash = createHash('sha256').update(`${method}\n${c.req.path}\n${new URL(c.req.url).search}\n${await c.req.text()}`).digest('hex');
    const claim = await deps.idempotency.claim(userId, key, hash);
    if (claim.kind === 'conflict') return fail('conflict');
    if (claim.kind === 'replay') {
      const rebuild = opts.rebuild?.[`${method} ${pattern}`];
      const built = rebuild === undefined ? plain(claim.response) : await rebuild(claim.response, c);
      const replay = new Response(built.body, { status: built.status, headers: new Headers(built.headers) });
      replay.headers.set('idempotent-replay', 'true');
      deps.log.info('http.idempotent_replay', { route: pattern });
      return replay;
    }

    try {
      await next();
    } catch (error) {
      await deps.idempotency.release(userId, key);
      throw error;
    }
    const kept = await keptResponse(c.res, opts.stored?.[`${method} ${pattern}`]);
    // The answer has been produced; failing to record it must not turn it into an error. The key then stays claimed until the daily clean-up.
    try {
      if (kept === undefined) await deps.idempotency.release(userId, key);
      else await deps.idempotency.complete(userId, key, kept);
    } catch {
      return undefined;
    }
    return undefined;
  };
}

/** The status and parsed JSON of a 2xx answer, or undefined when the answer is not worth replaying. */
async function keptResponse(res: Response, shape: ((body: unknown) => unknown) | undefined): Promise<StoredResponse | undefined> {
  if (res.status < 200 || res.status > 299) return undefined;
  const text = await res.clone().text();
  if (text === '') return { status: res.status, body: null };
  if (!(res.headers.get('content-type') ?? '').includes('json')) return undefined;
  try { const body = JSON.parse(text) as unknown; return { status: res.status, body: shape === undefined ? body : shape(body) }; } catch { return undefined; }
}
