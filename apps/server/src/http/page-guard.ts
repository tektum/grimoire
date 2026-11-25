import type { Context } from 'hono';
import { caller, callerTenant } from './collection-guard.js';
import type { Level } from './collection-guard.js';
import { fail } from './error.js';
import type { AppEnv } from './env.js';

/**
 * The `page` policy (contracts section 3): the access checker decides; a page the caller cannot read is 404 whatever the reason (unknown,
 * deleted, or not theirs), and one they can read but not write is 403 for `write`.
 */
export async function guardPage(c: Context<AppEnv>, pageId: string, need: 'read' | 'write'): Promise<Level> {
  const answer = await c.get('deps').access.pageAccess({ tenantId: callerTenant(c), userId: caller(c).id, pageId });
  if (answer.result === 'not-found') return fail('not_found');
  if (need === 'write' && answer.access !== 'read-write') return fail('forbidden');
  return answer.access;
}
