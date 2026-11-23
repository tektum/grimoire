import type { MiddlewareHandler } from 'hono';
import type { AuthVerifier } from '@tektum/grimoire-core/ports/auth-verifier';
import type { DevRoleSource } from '@tektum/grimoire-core/ports/dev-role';
import { fail } from './error.js';
import type { AppEnv, HttpDeps } from './env.js';

/** The one route that needs no credentials (contracts section 3). */
const isPublic = (method: string, path: string): boolean => method === 'GET' && path === '/v1/config';
/** The one route that accepts a verified identity that has no row yet: it creates the row. */
const isProvisioning = (method: string, path: string): boolean => method === 'GET' && path === '/v1/me';

const BEARER = /^Bearer ([^\s]+)$/i;

/**
 * Bearer authentication for every API route but the public one. The token is verified by the `AuthVerifier` port (the token policy is
 * the verifier's), the row is read from the user store, and the returning-user rule of the provisioner is applied from that stored
 * row on every route, so a user whose domain was removed stops working at once. A suspended user is refused everywhere.
 */
export function authenticate(verifier: AuthVerifier, deps: Pick<HttpDeps, 'users' | 'provisioner' | 'log' | 'config'>, roles?: DevRoleSource): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const method = c.req.method;
    const path = c.req.path;
    if (isPublic(method, path)) return next();

    const header = c.req.header('authorization');
    if (header === undefined) {
      deps.log.warn('http.auth_rejected', { reason: 'missing' });
      return fail('unauthenticated');
    }
    const token = BEARER.exec(header)?.[1];
    if (token === undefined) {
      deps.log.warn('http.auth_rejected', { reason: 'invalid' });
      return fail('unauthenticated');
    }

    const verified = await verifier.verify(token);
    if (verified.kind === 'service-unavailable') return fail('unavailable');
    if (verified.kind !== 'ok') {
      deps.log.warn('http.auth_rejected', { reason: 'invalid' });
      return fail('unauthenticated');
    }
    // The development role of the token is read in local mode only, as the collaboration host does.
    const devRole = roles !== undefined && deps.config.local ? roles.roleOf(token) : undefined;
    const identity = { userId: verified.userId, ...(verified.profile === undefined ? {} : { profile: verified.profile }) };

    const stored = await deps.users.findByDescopeId(identity.userId);
    if (stored === undefined) {
      if (!isProvisioning(method, path)) {
        deps.log.warn('http.auth_rejected', { reason: 'no-user' });
        return fail('forbidden');
      }
      c.set('identity', identity);
      if (devRole !== undefined) c.set('devRole', devRole);
      return next();
    }

    // A suspended user is refused everywhere, before the domain rule can give another reason.
    if (stored.suspended) {
      deps.log.warn('http.auth_rejected', { reason: 'suspended' });
      return fail('account_suspended');
    }
    // The returning-user rule on the row just read: no second query, and nothing can be created here.
    if (deps.provisioner.recheck({ identity, user: stored }).kind === 'refused') return fail('not_allowed');
    let user = stored;
    if (devRole !== undefined && devRole !== stored.role) {
      // Local mode: a changed development role is synced onto the stored row.
      const synced = await deps.provisioner.signIn({ identity, devRole });
      if (synced.kind === 'refused') return fail('not_allowed');
      user = synced.user;
    }
    c.set('identity', identity);
    c.set('user', user);
    return next();
  };
}
