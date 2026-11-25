import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { bodyLimit } from './http/body-limit.js';
import { secureHeaders } from 'hono/secure-headers';
import { routePath } from 'hono/route';
import { timeout } from 'hono/timeout';
import { ApiError, errorResponse } from './http/error.js';
import type { AppEnv } from './http/env.js';
import { createRouter } from './http/factory.js';
import { corsMiddleware } from './http/cors.js';
import { addressLimiter, userLimiter } from './http/rate-limit.js';
import { idempotency } from './http/idempotency.js';
import type { ReplayRebuild } from './http/idempotency.js';
import { authenticate } from './http/auth.js';
import { clientVersionGate } from './http/client-version.js';
import { routers } from './routes/registry.js';
import { routeReplays, routeStored } from './http/replays.js';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { errorName, errorOrigin } from './events.js';
import { shippedMigration } from './health/migrations.js';
import { healthRoutes } from './health/routes.js';
import { webClient } from './web/index.js';
import type { AppContext } from './composition.js';

export interface AppOptions {
  /** Largest accepted request body. */
  readonly bodyLimitBytes?: number;
  /** A handler slower than this answers 503 `unavailable`. Keep it above the seed time limit. */
  readonly requestTimeoutMs?: number;
  /** Newest migration /readyz requires; defaults to the newest the build ships. */
  readonly expectedMigration?: string;
  /** Replay hooks of idempotent routes, by `"METHOD /route/pattern"`; a route without one replays as stored. */
  readonly replayRebuild?: Readonly<Record<string, ReplayRebuild>>;
  /** Test seam: per-route stored form of an idempotent answer, added to the routes' own (`routeStored`). */
  readonly storedShape?: Readonly<Record<string, (body: unknown) => unknown>>;
  /** Test seam: true for the request that also cleans up old idempotency keys (about one in a hundred by default). */
  readonly idempotencySample?: () => boolean;
}

export const DEFAULT_BODY_LIMIT_BYTES = 1_048_576;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** The validator refuses a malformed JSON body with 400 and a wrong content type with 415: the client's mistake, not an outage. */
const isBodyRefusal = (err: unknown): boolean => err instanceof HTTPException && (err.status === 400 || err.status === 415);

/** Routes take everything from the context, never from globals. */
export function createApp(ctx: AppContext, opts: AppOptions = {}): OpenAPIHono<AppEnv> {
  const app = createRouter();
  // Hono prints the error, message and stack to stderr as free text by default. Log the class, method and route pattern only.
  // Only an error raised on purpose (`fail`) keeps its answer, and a refused request body answers 422; anything else is an unexpected failure and answers 503 with a fixed sentence.
  const handle = (err: unknown, c: Context): Response => {
    const response = err instanceof ApiError ? err.getResponse() : isBodyRefusal(err) ? errorResponse('invalid') : errorResponse('unavailable');
    const fields = { errorName: errorName(err), method: c.req.method, route: routePath(c), status: response.status };
    if (response.status >= 500) {
      const origin = errorOrigin(err);
      ctx.log.error('http.handler_error', origin === undefined ? fields : { ...fields, origin });
    } else ctx.log.warn('http.handler_rejected', fields);
    return response;
  };
  app.onError(handle);
  app.notFound(() => errorResponse('not_found'));
  // Hono hands only Error instances to onError and rethrows anything else (a thrown string), so catch those here.
  app.use(async (c, next) => {
    try {
      await next();
    } catch (e) {
      if (e instanceof Error) throw e;
      c.res = handle(e, c);
    }
  });
  app.use(async (c, next) => {
    c.set('deps', ctx.http);
    await next();
  });
  // The web client, when configured, serves its own documents with their own response headers (a content security policy for each, X-Frame-Options DENY): `finish` is outside the
  // security header defaults of the API, so it sets them last, and every other default (HSTS, cross-origin policies, ...) stays on the documents too.
  const web = ctx.config.webRoot === undefined || ctx.config.publicApiUrl === undefined || ctx.config.publicCollabUrl === undefined || ctx.config.files === undefined
    ? undefined
    : webClient({ root: ctx.config.webRoot, apiUrl: ctx.config.publicApiUrl, collabUrl: ctx.config.publicCollabUrl, storeOrigin: ctx.config.files.publicOrigin, descopeUrl: ctx.http.providerBaseUrl ?? undefined });
  if (web !== undefined) app.use(web.finish);
  app.use(secureHeaders());
  app.use(timeout(opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, () => new ApiError('unavailable')));
  // CORS covers the API paths and comes before the body limit, so a 413 can be read from an allowed origin. The health routes stay plain.
  app.use('/v1/*', corsMiddleware(ctx.config.allowedOrigins));
  // Before the body limit, which answers an oversized request without calling `next()`: every request counts against the address limits.
  app.use(addressLimiter(ctx.config.http, ctx.config.trustedProxies, ctx.log, (c) => web !== undefined && (c.req.method === 'GET' || c.req.method === 'HEAD') && web.serves(c.req.path)));
  app.use(bodyLimit({ maxSize: opts.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES }));
  app.route('/', healthRoutes({ db: ctx.db, log: ctx.log, clock: ctx.clock, isDraining: () => ctx.shutdown.isDraining(), expectedMigration: opts.expectedMigration ?? shippedMigration(), ...(ctx.jobs === undefined ? {} : { jobs: () => ctx.jobs?.state() ?? 'stopped' }) }));
  app.use(clientVersionGate(ctx.config.minClientVersion));
  app.use('/v1/*', authenticate(ctx.auth.verifier, ctx.http, ctx.auth.roles));
  app.use('/v1/*', userLimiter(app, ctx.config.http, ctx.log));
  app.use('/v1/*', idempotency(app, ctx.http, { rebuild: { ...routeReplays, ...opts.replayRebuild }, stored: { ...routeStored, ...opts.storedShape }, ...(opts.idempotencySample === undefined ? {} : { sample: opts.idempotencySample }) }));
  for (const router of routers) app.route('/', router);
  if (web !== undefined) app.use(web.middleware);
  return app;
}
