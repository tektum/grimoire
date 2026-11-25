import type { Context } from 'hono';
import type { UserRecord } from '@tektum/grimoire-core/ports/user-store';
import { fail } from './error.js';
import type { AppEnv } from './env.js';

export type Level = 'read-write' | 'read-only';

/** The signed-in user the authentication step stored; a route that is not provisioning never runs without one. */
export function caller(c: Context<AppEnv>): UserRecord {
  const user = c.get('user');
  return user ?? fail('unauthenticated');
}

/** The tenant of the signed-in user: the repository always fills it, and a row with none is `legacy` (docs/tenancy.md). */
export const callerTenant = (c: Context<AppEnv>): string => caller(c).tenantId ?? 'legacy';

/**
 * The `collection` policy (contracts section 3): the authoriser decides; a caller who cannot read the collection gets 404 whatever the
 * collection is (unknown, deleted, or not theirs), and one who can read but lacks the needed right gets 403. `write` also needs read-write access, `admin` also needs the role.
 * The collection is looked up in the caller's tenant first: one of another tenant is unknown, so that no answer, not even a 403, says it exists.
 */
export async function guardCollection(c: Context<AppEnv>, collectionId: string, need: 'read' | 'write' | 'admin'): Promise<Level> {
  const user = caller(c);
  if ((await c.get('deps').collections.get(callerTenant(c), collectionId)) === undefined) return fail('not_found');
  const decision = await c.get('deps').authorizer.checkCollection({ tenantId: callerTenant(c), userId: user.id, collectionId });
  if (decision.access === 'none') return fail('not_found');
  if (need === 'admin' && user.role !== 'admin') return fail('forbidden');
  if (need === 'write' && decision.access !== 'read-write') return fail('forbidden');
  return decision.access;
}
