import type { AccessFacts, AccessOptions, CollectionFacts, Permission } from '../ports/access-store.js';
import type { Role } from '../ports/user-store.js';

// R8.9 as code, the only implementation [R4.10, R8.15]. Pure and total: nothing here reads anything but its arguments.
// Default deny: whatever is not explicitly allowed (an unknown role, an unknown permission, a missing fact, a flag that is not literally `false`) is refused.

export type DenyReason = 'no-user' | 'suspended' | 'no-page' | 'deleted' | 'no-access';
export type AccessDecision = { access: 'read-write' | 'read-only'; epoch: number } | { access: 'none'; reason: DenyReason };
export type CollectionDecision =
  | { access: 'read-write' | 'read-only' }
  | { access: 'none'; reason: 'no-user' | 'suspended' | 'no-collection' | 'deleted' | 'no-access' };

type Level = 'read-write' | 'read-only';
interface UserFacts { readonly role: Role; readonly suspended: boolean }
interface CollectionGrant { readonly defaultPermission: Permission | null; readonly entries: readonly Permission[] }

const rank = (p: unknown): number => (p === 'read_write' ? 2 : p === 'read' ? 1 : 0);

/** The level the user's role and the collection's permissions give, or undefined for none. */
function grant(user: UserFacts, c: CollectionGrant): Level | undefined {
  let best = rank(c.defaultPermission);
  if (Array.isArray(c.entries)) for (const e of c.entries) best = Math.max(best, rank(e));
  let level: number;
  switch (user.role) {
    case 'admin': level = 2; break;
    case 'member': level = best; break;
    case 'viewer': level = Math.min(best, 1); break;
    default: level = 0;
  }
  return level === 2 ? 'read-write' : level === 1 ? 'read-only' : undefined;
}

export function decideCollection(f: CollectionFacts, opts?: AccessOptions): CollectionDecision {
  if (!f.user) return { access: 'none', reason: 'no-user' };
  if (f.user.suspended !== false) return { access: 'none', reason: 'suspended' };
  if (!f.collection) return { access: 'none', reason: 'no-collection' };
  // A collection of another tenant is a collection that is not there (docs/tenancy.md, 3.3), as for a page: equal when neither says one, and one without the other denies.
  if (f.user.tenantId !== f.collection.tenantId) return { access: 'none', reason: 'no-collection' };
  if (f.collection.deleted !== false && opts?.includeDeleted !== true) return { access: 'none', reason: 'deleted' };
  const access = grant(f.user, f.collection);
  return access ? { access } : { access: 'none', reason: 'no-access' };
}

export function decide(f: AccessFacts, opts?: AccessOptions): AccessDecision {
  if (!f.user) return { access: 'none', reason: 'no-user' };
  if (f.user.suspended !== false) return { access: 'none', reason: 'suspended' };
  if (!f.page || !Number.isSafeInteger(f.page.epoch) || f.page.epoch < 0) return { access: 'none', reason: 'no-page' };
  // A page of another tenant is a page that is not there (docs/tenancy.md, 3.3): checked before anything about the page's state, so the trash routes' `includeDeleted` and a
  // generous collection cannot reach across. Equal means equal when neither says one (a store that knows nothing of tenants); one without the other denies.
  if (f.user.tenantId !== f.page.tenantId) return { access: 'none', reason: 'no-page' };
  if ((f.page.deleted !== false || f.page.collection.deleted !== false) && opts?.includeDeleted !== true) return { access: 'none', reason: 'deleted' };
  const access = grant(f.user, f.page.collection);
  return access ? { access, epoch: f.page.epoch } : { access: 'none', reason: 'no-access' };
}
