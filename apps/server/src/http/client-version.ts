import type { MiddlewareHandler } from 'hono';
import { compareVersions, parseVersion } from '@tektum/grimoire-core/version';
import { fail } from './error.js';
import { CLIENT_VERSION_HEADER } from './cors.js';

/** The client reads the minimum from this route, so it is never refused. The health routes are mounted before the gate and never reach it. */
const EXEMPT = new Set(['/v1/config']);

/** Refuses a client that names a valid version below the minimum (R4.32). A missing or malformed header passes, so curl and other clients keep working. */
export function clientVersionGate(minClientVersion: string): MiddlewareHandler {
  const minimum = parseVersion(minClientVersion);
  return async (c, next) => {
    if (minimum !== null && !EXEMPT.has(c.req.path)) {
      const sent = parseVersion(c.req.header(CLIENT_VERSION_HEADER) ?? '');
      if (sent !== null && compareVersions(sent, minimum) < 0) fail('client_too_old');
    }
    await next();
  };
}
