import type { AccessFacts, AccessOptions, AccessRequest, AccessStore, CollectionAccessRequest, CollectionFacts, Permission } from '../ports/access-store.js';
import type { Role } from '../ports/user-store.js';
import { decideCollection } from '../authorize/decide.js';

/** A small permission world: the same data is loaded into the fake store and into PostgreSQL by the tests. */
export interface World {
  users: { id: string; role: Role; suspended: boolean; tenantId?: string }[];
  groups: { id: string }[];
  members: { groupId: string; userId: string }[];
  collections: { id: string; deleted: boolean; defaultPermission: Permission | null; position?: string; tenantId?: string }[];
  access: { collectionId: string; userId?: string; groupId?: string; permission: Permission }[];
  pages: { id: string; collectionId: string; deleted: boolean; epoch: number; tenantId?: string }[];
}

export function emptyWorld(): World {
  return { users: [], groups: [], members: [], collections: [], access: [], pages: [] };
}

/** In-memory AccessStore over a `World`, written independently of the SQL: the reference the PostgreSQL store is compared with. */
export function createFakeAccessStore(world: World): AccessStore {
  const userFacts = (id: string): { role: Role; suspended: boolean; tenantId?: string } | undefined => {
    const u = world.users.find((x) => x.id === id);
    return u ? { role: u.role, suspended: u.suspended, ...(u.tenantId === undefined ? {} : { tenantId: u.tenantId }) } : undefined;
  };
  const collectionOf = (collectionId: string, userId: string) => {
    const c = world.collections.find((x) => x.id === collectionId);
    if (!c) return undefined;
    const groups = new Set(world.members.filter((m) => m.userId === userId).map((m) => m.groupId));
    const entries = world.access
      .filter((a) => a.collectionId === collectionId && ((a.userId !== undefined && a.userId === userId) || (a.groupId !== undefined && groups.has(a.groupId))))
      .map((a) => a.permission);
    return { deleted: c.deleted, defaultPermission: c.defaultPermission, entries, ...(c.tenantId === undefined ? {} : { tenantId: c.tenantId }) };
  };
  const collectionFacts = (r: CollectionAccessRequest): CollectionFacts => {
    const user = userFacts(r.userId);
    const collection = collectionOf(r.collectionId, r.userId);
    return { request: r, ...(user ? { user } : {}), ...(collection ? { collection } : {}) };
  };
  const pageFacts = (r: AccessRequest): AccessFacts => {
    const user = userFacts(r.userId);
    const p = world.pages.find((x) => x.id === r.pageId);
    const collection = p ? collectionOf(p.collectionId, r.userId) : undefined;
    return { request: r, ...(user ? { user } : {}), ...(p && collection ? { page: { deleted: p.deleted, epoch: p.epoch, collection, ...(p.tenantId === undefined ? {} : { tenantId: p.tenantId }) } } : {}) };
  };
  return {
    facts: (rs) => Promise.resolve(rs.map(pageFacts)),
    collectionFacts: (rs) => Promise.resolve(rs.map(collectionFacts)),
    visibleCollections(tenantId: string, userId: string, opts?: AccessOptions) {
      const out: { collectionId: string; access: 'read-write' | 'read-only' }[] = [];
      for (const c of world.collections) {
        const d = decideCollection(collectionFacts({ tenantId, userId, collectionId: c.id }), opts);
        if (d.access !== 'none') out.push({ collectionId: c.id, access: d.access });
      }
      return Promise.resolve(out);
    },
  };
}
