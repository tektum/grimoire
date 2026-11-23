import type { MiddlewareHandler } from 'hono';
import type { AuthVerifier } from '@tektum/grimoire-core/ports/auth-verifier';
import type { UserRecord, UserStore } from '@tektum/grimoire-core/ports/user-store';
import { createProvisioner } from '@tektum/grimoire-core/users/provisioner';
import type { SignInPolicy } from '@tektum/grimoire-core/users/provisioner';
import { fail } from './error.js';
import type { AppEnv, HttpDeps } from './env.js';

/** The one route that needs no credentials (contracts section 3). */
const isPublic = (method: string, path: string): boolean => method === 'GET' && path === '/v1/config';
/** The one route that accepts a verified identity that has no row yet: it creates the row. */
const isProvisioning = (method: string, path: string): boolean => method === 'GET' && path === '/v1/me';

const BEARER = /^Bearer ([^\s]+)$/i;

/** A store that answers the one row already read, so the rule runs on it without a second query. */
const readOnce = (users: UserStore, row: UserRecord): UserStore => ({
  findByDescopeId: () => Promise.resolve(row),
  createIfAbsent: (n) => users.createIfAbsent(n),
  updateRole: (id, role) => users.updateRole(id, role),
});

/**
 * Bearer authentication for every API route but the public one. The token is verified by the `AuthVerifier` port (the token policy is
 * the verifier's), the row is read from the user store, and the returning-user rule of the provisioner is applied from that stored
 * row on every route, so a user whose domain was removed stops working at once. A suspended user is refused everywhere.
 */
export function authenticate(verifier: AuthVerifier, policy: SignInPolicy, deps: Pick<HttpDeps, 'users' | 'log'>): MiddlewareHandler<AppEnv> {
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
    const identity = { userId: verified.userId, ...(verified.profile === undefined ? {} : { profile: verified.profile }) };

    const stored = await deps.users.findByDescopeId(identity.userId);
    if (stored === undefined) {
      if (!isProvisioning(method, path)) {
        deps.log.warn('http.auth_rejected', { reason: 'no-user' });
        return fail('forbidden');
      }
      c.set('identity', identity);
      return next();
    }

    const checked = await createProvisioner({ users: readOnce(deps.users, stored), verifier, policy }).signIn({ identity });
    if (checked.kind === 'refused') return fail('not_allowed');
    if (checked.user.suspended) {
      deps.log.warn('http.auth_rejected', { reason: 'suspended' });
      return fail('account_suspended');
    }
    c.set('identity', identity);
    c.set('user', checked.user);
    return next();
  };
}
