import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { routeReplays } from '../../src/http/replays.js';
import { makeContext } from '../server/support/context.js';

/**
 * Idempotent routes whose replay cannot leak access, each with the reason on the same line. A route is added here only when a replay
 * of its stored answer shows nothing that the caller's rights could have changed since. Every other idempotent route needs a hook in
 * `http/replays.ts`, which checks the caller's rights again before the stored answer is sent.
 */
const EXEMPT: Readonly<Record<string, string>> = {};

/** `METHOD /route/:param`, as the idempotency step names a route. */
function idempotentRoutes(): string[] {
  const app = createApp(makeContext().ctx);
  const routes: string[] = [];
  for (const d of app.openAPIRegistry.definitions) {
    if (d.type !== 'route') continue;
    if ((d.route as unknown as Record<string, unknown>)['x-grimoire-idempotent'] !== true) continue;
    routes.push(`${d.route.method.toUpperCase()} ${d.route.path.replace(/\{([^}]+)\}/g, ':$1')}`);
  }
  return routes;
}

describe('replay hooks of idempotent routes', () => {
  it('finds the idempotent routes at all', () => {
    expect(idempotentRoutes()).toEqual(expect.arrayContaining(['POST /v1/collections', 'POST /v1/pages']));
  });

  it('has a hook in http/replays.ts, or a reason in the exempt list, for every idempotent route', () => {
    const missing = idempotentRoutes().filter((route) => routeReplays[route] === undefined && (EXEMPT[route] ?? '') === '');
    expect(missing).toEqual([]);
  });

  it('names no route that is not idempotent, in the hooks or in the exempt list', () => {
    const known = new Set(idempotentRoutes());
    expect([...Object.keys(routeReplays), ...Object.keys(EXEMPT)].filter((route) => !known.has(route))).toEqual([]);
  });

  it('does not list a route as exempt and hooked at once', () => {
    expect(Object.keys(EXEMPT).filter((route) => routeReplays[route] !== undefined)).toEqual([]);
  });
});
