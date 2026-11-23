import type { Context, MiddlewareHandler } from 'hono';
import { routePath } from 'hono/route';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import type { RateLimiterRes } from 'rate-limiter-flexible';
import type { HttpConfig } from '@tektum/grimoire-core/ports/config';
import { errorResponse } from './error.js';
import { clientAddress, trustedProxyList } from './address.js';
import type { AppEnv, HttpDeps } from './env.js';
import type { RouteRateLimit } from './policy.js';

const WINDOW_SECONDS = 60;
/** Orchestrator probes (GET, or HEAD served by the same handler) carry no credentials and come from one address all day: they are not counted (their answers are plain text and cost nothing). */
const PROBES = new Set(['/healthz', '/readyz']);
const BEARER = /^Bearer [^\s]+$/i;

/** Consumes one point; answers the seconds to wait when the key is over its limit, otherwise undefined. */
async function consume(limiter: RateLimiterMemory, key: string): Promise<number | undefined> {
  try {
    await limiter.consume(key);
    return undefined;
  } catch (rejection) {
    return Math.max(1, Math.ceil((rejection as RateLimiterRes).msBeforeNext / 1000));
  }
}

function refuse(log: HttpDeps['log'], c: Context, scope: 'user' | 'address' | 'route', seconds: number): Response {
  log.warn('http.rate_limited', { scope, route: routePath(c, -1) });
  return errorResponse('rate_limited', undefined, { 'retry-after': String(seconds) });
}

/**
 * Limits per address, before any token work. Every request counts against the flood ceiling. A request with no bearer or a malformed one
 * also counts against the credential counter, and so does a request whose token fails verification, after the fact. A valid, signed-in
 * request never touches the credential counter, so many users behind one office address are limited per user only.
 */
export function addressLimiter(http: HttpConfig, trustedProxies: readonly string[], log: HttpDeps['log']): MiddlewareHandler<AppEnv> {
  const ceiling = new RateLimiterMemory({ points: http.addressCeilingPerMinute, duration: WINDOW_SECONDS });
  const credentials = new RateLimiterMemory({ points: http.addressLimitPerMinute, duration: WINDOW_SECONDS });
  const trusted = trustedProxyList(trustedProxies);
  return async (c, next) => {
    if ((c.req.method === 'GET' || c.req.method === 'HEAD') && PROBES.has(c.req.path)) return next();
    const address = clientAddress(c, trusted);
    const flooded = await consume(ceiling, address);
    if (flooded !== undefined) return refuse(log, c, 'address', flooded);
    const wellFormed = BEARER.test(c.req.header('authorization') ?? '');
    if (!wellFormed) {
      const blocked = await consume(credentials, address);
      if (blocked !== undefined) return refuse(log, c, 'address', blocked);
    }
    await next();
    // The only 401 a well-formed token can get is a failed verification (suspended and unknown users are 403, an outage is 503).
    if (wellFormed && c.res.status === 401) {
      const blocked = await consume(credentials, address);
      if (blocked !== undefined) c.res = refuse(log, c, 'address', blocked);
    }
  };
}

/**
 * The value of a route extension (`x-grimoire-rate-limit`, `x-grimoire-idempotent`) for the routes defined so far, found by method and
 * route pattern. The table is rebuilt when a route is added, so routes need no registration of their own.
 */
export function routeExtension<T>(app: OpenAPIHono<AppEnv>, extension: string): (method: string, pattern: string) => T | undefined {
  let seen = -1;
  let table = new Map<string, T>();
  return (method, pattern) => {
    const definitions = app.openAPIRegistry.definitions;
    if (definitions.length !== seen) {
      seen = definitions.length;
      table = new Map();
      for (const d of definitions) {
        if (d.type !== 'route') continue;
        const value = (d.route as unknown as Record<string, T | undefined>)[extension];
        if (value !== undefined) table.set(`${d.route.method.toUpperCase()} ${d.route.path.replace(/\{([^}]+)\}/g, ':$1')}`, value);
      }
    }
    return table.get(`${method.toUpperCase()} ${pattern}`);
  };
}

/** Limits per signed-in user, keyed by the user's id (never by a header or an address): overall, and per route where the route declares it. */
export function userLimiter(app: OpenAPIHono<AppEnv>, http: HttpConfig, log: HttpDeps['log']): MiddlewareHandler<AppEnv> {
  const overall = new RateLimiterMemory({ points: http.userLimitPerMinute, duration: WINDOW_SECONDS });
  const perRoute = new Map<string, RateLimiterMemory>();
  const limitOf = routeExtension<RouteRateLimit>(app, 'x-grimoire-rate-limit');
  return async (c, next) => {
    const who = c.get('user')?.id ?? c.get('identity')?.userId;
    if (who === undefined) return next();
    const blocked = await consume(overall, who);
    if (blocked !== undefined) return refuse(log, c, 'user', blocked);
    const pattern = routePath(c, -1);
    const limit = limitOf(c.req.method, pattern);
    if (limit !== undefined) {
      const key = `${c.req.method} ${pattern}`;
      let limiter = perRoute.get(key);
      if (limiter === undefined) {
        limiter = new RateLimiterMemory({ points: limit.max, duration: limit.windowSeconds });
        perRoute.set(key, limiter);
      }
      const wait = await consume(limiter, who);
      if (wait !== undefined) return refuse(log, c, 'route', wait);
    }
    return next();
  };
}
