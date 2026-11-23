import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { routePath } from 'hono/route';
import { timeout } from 'hono/timeout';
import { ApiError, errorResponse } from './http/error.js';
import type { AppEnv } from './http/env.js';
import { createRouter } from './http/factory.js';
import { routers } from './routes/registry.js';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { errorName } from './events.js';
import { shippedMigration } from './health/migrations.js';
import { healthRoutes } from './health/routes.js';
import type { AppContext } from './composition.js';

export interface AppOptions {
  /** Largest accepted request body. */
  readonly bodyLimitBytes?: number;
  /** A handler slower than this answers 503 `unavailable`. Keep it above the seed time limit. */
  readonly requestTimeoutMs?: number;
  /** Newest migration /readyz requires; defaults to the newest the build ships. */
  readonly expectedMigration?: string;
}

export const DEFAULT_BODY_LIMIT_BYTES = 1_048_576;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Routes take everything from the context, never from globals. */
export function createApp(ctx: AppContext, opts: AppOptions = {}): OpenAPIHono<AppEnv> {
  const app = createRouter();
  // Hono prints the error, message and stack to stderr as free text by default. Log the class, method and route pattern only.
  // Only an error raised on purpose (`fail`) keeps its answer; anything else is an unexpected failure and answers 503 with a fixed sentence.
  const handle = (err: unknown, c: Context): Response => {
    const own = err instanceof ApiError;
    const response = own ? err.getResponse() : errorResponse('unavailable');
    const fields = { errorName: errorName(err), method: c.req.method, route: routePath(c), status: response.status };
    if (response.status >= 500) ctx.log.error('http.handler_error', fields);
    else ctx.log.warn('http.handler_rejected', fields);
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
  app.use(secureHeaders());
  app.use(timeout(opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, () => new ApiError('unavailable')));
  app.use(bodyLimit({ maxSize: opts.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES, onError: () => errorResponse('too_large') }));
  app.route('/', healthRoutes({ db: ctx.db, log: ctx.log, clock: ctx.clock, isDraining: () => ctx.shutdown.isDraining(), expectedMigration: opts.expectedMigration ?? shippedMigration() }));
  for (const router of routers) app.route('/', router);
  return app;
}
