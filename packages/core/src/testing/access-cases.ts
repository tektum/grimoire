import type { AccessFacts, CollectionFacts, Permission } from '../ports/access-store.js';
import type { Role } from '../ports/user-store.js';
import type { DenyReason } from '../authorize/decide.js';
import { emptyWorld } from './fake-access-store.js';
import type { World } from './fake-access-store.js';

/** What a row expects: an access level or the reason for refusal. */
export type Expected = 'read-write' | 'read-only' | DenyReason | 'no-collection';

export interface AccessCase {
  /** The wording of the rule, used as the test name. */
  readonly name: string;
  /** Absent: the user does not exist. */
  readonly role?: Role;
  readonly suspended: boolean;
  readonly collection: 'live' | 'deleted' | 'missing';
  readonly page: 'live' | 'deleted' | 'missing';
  readonly defaultPermission: Permission | null;
  readonly ownEntry?: Permission;
  readonly groupEntries: readonly Permission[];
  readonly includeDeleted: boolean;
  readonly expect: Expected;
  /** The collection form's expectation; absent: the page row's expectation (rows with a live page only), 'skip': no collection row. */
  readonly collectionExpect?: Expected | 'skip';
}

type Spec = Partial<Omit<AccessCase, 'name' | 'expect'>>;
const row = (name: string, spec: Spec, expect: Expected): AccessCase => ({
  name, suspended: false, collection: 'live', page: 'live', defaultPermission: null, groupEntries: [], includeDeleted: false, expect, ...spec,
});

// Per situation, the expectation for [admin, member, viewer].
const RW = 'read-write', RO = 'read-only', NO = 'no-access';
const matrix: readonly { situation: string; spec: Spec; expect: readonly [Expected, Expected, Expected] }[] = [
  { situation: 'no default permission and no entries', spec: {}, expect: [RW, NO, NO] },
  { situation: 'default read', spec: { defaultPermission: 'read' }, expect: [RW, RO, RO] },
  { situation: 'default read_write', spec: { defaultPermission: 'read_write' }, expect: [RW, RW, RO] },
  { situation: 'own entry read', spec: { ownEntry: 'read' }, expect: [RW, RO, RO] },
  { situation: 'own entry read_write', spec: { ownEntry: 'read_write' }, expect: [RW, RW, RO] },
  { situation: 'group entry read', spec: { groupEntries: ['read'] }, expect: [RW, RO, RO] },
  { situation: 'group entry read_write', spec: { groupEntries: ['read_write'] }, expect: [RW, RW, RO] },
  { situation: 'default read and own entry read_write', spec: { defaultPermission: 'read', ownEntry: 'read_write' }, expect: [RW, RW, RO] },
  { situation: 'default read_write and group entry read', spec: { defaultPermission: 'read_write', groupEntries: ['read'] }, expect: [RW, RW, RO] },
  { situation: 'two group entries, read and read_write', spec: { groupEntries: ['read', 'read_write'] }, expect: [RW, RW, RO] },
];
const roles: readonly Role[] = ['admin', 'member', 'viewer'];

export const accessCases: readonly AccessCase[] = [
  ...matrix.flatMap((m) => roles.map((role, i) => row(`${role}: ${m.situation}`, { ...m.spec, role }, m.expect[i] ?? NO))),
  // A suspended user is refused whatever the role and the grants.
  ...roles.map((role) => row(`suspended ${role} with default read_write: suspended`, { role, suspended: true, defaultPermission: 'read_write', ownEntry: 'read_write' }, 'suspended')),
  row('suspended user on a missing page: suspended', { role: 'member', suspended: true, page: 'missing', collection: 'missing' }, 'suspended'),
  // Deleted page or deleted collection, all roles.
  ...roles.map((role) => row(`${role}: deleted page: deleted`, { role, page: 'deleted', defaultPermission: 'read_write' }, 'deleted')),
  ...roles.map((role) => row(`${role}: page in a deleted collection: deleted`, { role, collection: 'deleted', defaultPermission: 'read_write' }, 'deleted')),
  row('admin: page in a deleted collection and deleted itself: deleted', { role: 'admin', collection: 'deleted', page: 'deleted' }, 'deleted'),
  // Missing facts.
  row('missing user: no-user', { defaultPermission: 'read_write' }, 'no-user'),
  row('missing user on a missing page: no-user', { page: 'missing', collection: 'missing' }, 'no-user'),
  row('member: missing page: no-page', { role: 'member', page: 'missing', collection: 'missing', defaultPermission: 'read_write' }, 'no-page'),
  row('admin: missing page: no-page', { role: 'admin', page: 'missing', collection: 'missing' }, 'no-page'),

  // includeDeleted: trash routes decide deleted pages and collections as if live.
  row('includeDeleted, member: deleted page with default read_write: read-write', { role: 'member', page: 'deleted', defaultPermission: 'read_write', includeDeleted: true }, 'read-write'),
  row('includeDeleted, viewer: page in a deleted collection with default read_write: read-only', { role: 'viewer', collection: 'deleted', defaultPermission: 'read_write', includeDeleted: true }, 'read-only'),
  row('includeDeleted, admin: deleted page in a deleted collection: read-write', { role: 'admin', collection: 'deleted', page: 'deleted', includeDeleted: true }, 'read-write'),
  row('includeDeleted, member: deleted page without any grant: no-access', { role: 'member', page: 'deleted', includeDeleted: true }, 'no-access'),
  row('includeDeleted, admin: suspended: suspended', { role: 'admin', suspended: true, page: 'deleted', includeDeleted: true }, 'suspended'),
  row('includeDeleted, member: missing page: no-page', { role: 'member', page: 'missing', collection: 'missing', includeDeleted: true }, 'no-page'),
  row('includeDeleted, no user: no-user', { page: 'deleted', includeDeleted: true }, 'no-user'),
];

/** The collection form's expectation for a row: a live page gives the page's answer, a deleted page says nothing about its (live) collection, a missing page means the collection is asked for as missing. */
export function collectionExpectOf(c: AccessCase): Expected | 'skip' {
  if (c.collectionExpect !== undefined) return c.collectionExpect;
  return c.page === 'deleted' ? 'skip' : collectionReason(c.expect);
}

/** The reason of a page decision as the collection form names it. */
export const collectionReason = (e: Expected): Expected => (e === 'no-page' ? 'no-collection' : e);

export interface CaseIds { readonly userId: string; readonly pageId: string; readonly collectionId: string }

const hex = (n: number): string => n.toString(16).padStart(12, '0');
/** A UUID that is valid for PostgreSQL: `kind` tells the tables apart. */
export const uuidOf = (kind: 'user' | 'group' | 'collection' | 'page' | 'absent', n: number): string => {
  const prefix = { user: '1', group: '2', collection: '3', page: '4', absent: '9' }[kind];
  return `${prefix}0000000-0000-4000-8000-${hex(n)}`;
};

/** One world holding every row's own user, groups, collection and page, so the table runs in one go. Ids per row index. */
export function worldOfCases(cases: readonly AccessCase[] = accessCases): { world: World; ids: readonly CaseIds[] } {
  const world = emptyWorld();
  const ids = cases.map((c, i): CaseIds => {
    const n = i + 1;
    const userId = uuidOf(c.role ? 'user' : 'absent', n);
    const collectionId = uuidOf(c.collection === 'missing' ? 'absent' : 'collection', n);
    const pageId = uuidOf(c.page === 'missing' ? 'absent' : 'page', n);
    if (c.role) world.users.push({ id: userId, role: c.role, suspended: c.suspended });
    if (c.collection !== 'missing') {
      world.collections.push({ id: collectionId, deleted: c.collection === 'deleted', defaultPermission: c.defaultPermission, position: `a${String(n).padStart(4, '0')}` });
      if (c.ownEntry && c.role) world.access.push({ collectionId, userId, permission: c.ownEntry });
      c.groupEntries.forEach((permission, k) => {
        const groupId = uuidOf('group', n * 10 + k);
        world.groups.push({ id: groupId });
        if (c.role) world.members.push({ groupId, userId });
        world.access.push({ collectionId, groupId, permission });
      });
      // A group the user is not in, with read_write: must never count.
      if (c.role) {
        const other = uuidOf('group', n * 10 + 9);
        world.groups.push({ id: other });
        world.access.push({ collectionId, groupId: other, permission: 'read_write' });
      }
      if (c.page !== 'missing') world.pages.push({ id: pageId, collectionId, deleted: c.page === 'deleted', epoch: n });
    }
    return { userId, pageId, collectionId };
  });
  return { world, ids };
}

/** AccessFacts for a row, written out by hand from the row (no store involved): feeds `decide` directly. */
export function factsOfCase(c: AccessCase, ids: CaseIds, epoch: number): AccessFacts {
  const entries = [...(c.ownEntry ? [c.ownEntry] : []), ...c.groupEntries];
  const collection = { deleted: c.collection === 'deleted', defaultPermission: c.defaultPermission, entries };
  return {
    request: { userId: ids.userId, pageId: ids.pageId },
    ...(c.role ? { user: { role: c.role, suspended: c.suspended } } : {}),
    ...(c.page !== 'missing' ? { page: { deleted: c.page === 'deleted', epoch, collection } } : {}),
  };
}

export function collectionFactsOfCase(c: AccessCase, ids: CaseIds): CollectionFacts {
  const entries = [...(c.ownEntry ? [c.ownEntry] : []), ...c.groupEntries];
  return {
    request: { userId: ids.userId, collectionId: ids.collectionId },
    ...(c.role ? { user: { role: c.role, suspended: c.suspended } } : {}),
    ...(c.collection !== 'missing' ? { collection: { deleted: c.collection === 'deleted', defaultPermission: c.defaultPermission, entries } } : {}),
  };
}
