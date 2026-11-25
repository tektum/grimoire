import type { Context } from 'hono';
import type { ImportRecord } from '@tektum/grimoire-core/ports/import-repo';
import { caller, callerTenant } from './collection-guard.js';
import { fail } from './error.js';
import type { AppEnv } from './env.js';

/**
 * The `import` policy (contracts section 3): the import is looked up in the caller's tenant, so one of another tenant is unknown. Whoever is not allowed to see it gets 404, never 403, so
 * that no answer says it exists: `creator` is the person who made it and nobody else (an administrator included), `creator-or-admin` adds an administrator of the caller's workspace.
 */
export async function guardImport(c: Context<AppEnv>, importId: string, who: 'creator' | 'creator-or-admin'): Promise<ImportRecord> {
  const user = caller(c);
  const row = await c.get('deps').imports.get(callerTenant(c), importId);
  if (row === undefined) return fail('not_found');
  const allowed = row.createdBy === user.id || (who === 'creator-or-admin' && user.role === 'admin');
  return allowed ? row : fail('not_found');
}
