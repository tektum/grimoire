import type { Role } from './user-store.js';

/** A user as an administrator sees them (the only list that carries an email address). */
export interface AdminUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly role: Role;
  readonly suspended: boolean;
}

export interface UserPatch { readonly role?: Role | undefined; readonly suspended?: boolean | undefined }

/** `last-admin`: the change would leave no active administrator; nothing was written. */
export type PatchUserResult = { kind: 'saved'; user: AdminUser } | { kind: 'not-found' } | { kind: 'last-admin' };

export interface UserListQuery {
  /** Case-insensitive part of the name or the email. */
  readonly q?: string;
  readonly limit: number;
  /** The `(email, id)` of the last row of the previous page. */
  readonly after?: readonly [string, string];
}

export interface AdminGroup { readonly id: string; readonly name: string; readonly memberCount: number }

export type GroupSaveResult = { kind: 'saved'; group: AdminGroup } | { kind: 'name-taken' } | { kind: 'not-found' };
export type MemberAddResult = 'added' | 'already-member' | 'no-group' | 'no-user';

/**
 * Users and groups for administrators. Every change writes its audit row in the same transaction. Every method works inside one tenant (docs/tenancy.md section 3.3): a user
 * or a group of another tenant is absent (`not-found`, `no-group`, `no-user`, false or undefined, as for an unknown id), never an error that says it exists.
 */
export interface AdminRepo {
  /** Up to `limit` rows in `(email, id)` order; the caller asks for one more than it shows. */
  listUsers(tenantId: string, query: UserListQuery): Promise<readonly AdminUser[]>;
  /** Changes role and/or suspension. A value equal to the stored one writes nothing and no audit row. */
  patchUser(tenantId: string, id: string, patch: UserPatch, actorId: string): Promise<PatchUserResult>;
  /** Display names of the ids that exist; unknown ids are left out. */
  userNames(tenantId: string, ids: readonly string[]): Promise<readonly { id: string; name: string }[]>;
  /** Every group in name order (case-insensitive). */
  listGroups(tenantId: string): Promise<readonly AdminGroup[]>;
  /** `name-taken` when a group of that name exists, whatever the case. */
  createGroup(tenantId: string, name: string, actorId: string): Promise<GroupSaveResult>;
  renameGroup(tenantId: string, id: string, name: string, actorId: string): Promise<GroupSaveResult>;
  /** Removes the group, its members and its collection access entries together. False when there is no such group. */
  deleteGroup(tenantId: string, id: string, actorId: string): Promise<boolean>;
  /** Members in `(email, id)` order; undefined when there is no such group. */
  listMembers(tenantId: string, groupId: string): Promise<readonly AdminUser[] | undefined>;
  /** Adding a member who is in already changes nothing and writes no audit row. */
  addMember(tenantId: string, groupId: string, userId: string, actorId: string): Promise<MemberAddResult>;
  removeMember(tenantId: string, groupId: string, userId: string, actorId: string): Promise<boolean>;
}
