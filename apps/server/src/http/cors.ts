import { cors } from 'hono/cors';
import type { MiddlewareHandler } from 'hono';

export const CLIENT_VERSION_HEADER = 'X-Grimoire-Client-Version';

/** Cross-origin access for the configured origins only. Sign-in is a bearer token, so credentials are never allowed and no cookie is ever involved. */
export function corsMiddleware(allowedOrigins: readonly string[]): MiddlewareHandler {
  return cors({
    origin: allowedOrigins.map((o) => new URL(o).origin),
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', CLIENT_VERSION_HEADER],
    exposeHeaders: ['Retry-After', 'Idempotent-Replay'],
    maxAge: 600,
    credentials: false,
  });
}
