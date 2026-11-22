import { Hono } from 'hono';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { HTTPException } from 'hono/http-exception';
import { routePath } from 'hono/route';
import { timeout } from 'hono/timeout';
import { errorName } from './events.js';
import { shippedMigration } from './health/migrations.js';
import { healthRoutes } from './health/routes.js';
import type { AppContext } from './composition.js';

export interface AppOptions {
  /** Largest accepted request body. */
  readonly bodyLimitBytes?: number;
  /** A handler slower than this gets the timeout middleware's default 504. */
  readonly requestTimeoutMs?: number;
  /** Newest migration /readyz requires; defaults to the newest the build ships. */
  readonly expectedMigration?: string;
}

export const DEFAULT_BODY_LIMIT_BYTES = 1_048_576;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Routes take everything from the context, never from globals. */
export function createApp(ctx: AppContext, opts: AppOptions = {}): Hono {
  const app = new Hono();
  // Without this Hono prints the error, message and stack, to stderr as free text. Log the class, method and route pattern only.
  const fail = (err: unknown, c: Context): Response => {
    const status = err instanceof HTTPException ? err.status : 500;
    const fields = { errorName: errorName(err), method: c.req.method, route: routePath(c), status };
    if (status >= 500) ctx.log.error('http.handler_error', fields);
    else ctx.log.warn('http.handler_rejected', fields);
    return c.text(status >= 500 ? 'internal error' : 'error', status);
  };
  app.onError(fail);
  // Hono hands only Error instances to onError and rethrows anything else (a thrown string), so catch those here.
  app.use(async (c, next) => {
    try {
      await next();
    } catch (e) {
      if (e instanceof Error) throw e;
      c.res = fail(e, c);
    }
  });
  app.use(secureHeaders());
  app.use(timeout(opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS));
  app.use(bodyLimit({ maxSize: opts.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES }));
  app.route('/', healthRoutes({ db: ctx.db, log: ctx.log, clock: ctx.clock, isDraining: () => ctx.shutdown.isDraining(), expectedMigration: opts.expectedMigration ?? shippedMigration() }));
  return app;
}
