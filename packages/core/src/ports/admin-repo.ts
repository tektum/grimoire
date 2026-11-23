/** The three roles of a user (the same values as `Role` of the user store; a port here imports nothing). */
export type AdminRole = 'admin' | 'member' | 'viewer';

/** A user as an administrator sees them (the only list that carries an email address). */
export interface AdminUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly role: AdminRole;
  readonly suspended: boolean;
}

export interface UserPatch { readonly role?: AdminRole | undefined; readonly suspended?: boolean | undefined }

/** `last-admin`: the change would leave no active administrator; nothing was written. */
export type PatchUserResult = { kind: 'saved'; user: AdminUser } | { kind: 'not-found' } | { kind: 'last-admin' };

export interface UserListQuery {
  /** Case-insensitive part of the name or the email. */
  readonly q?: string;
  readonly limit: number;
  /** The `(email, id)` of the last row of the previous page. */
  readonly after?: readonly [string, string];
}

/** Users and groups for administrators. Every change writes its audit row in the same transaction. */
export interface AdminRepo {
  /** Up to `limit` rows in `(email, id)` order; the caller asks for one more than it shows. */
  listUsers(query: UserListQuery): Promise<readonly AdminUser[]>;
  /** Changes role and/or suspension. A value equal to the stored one writes nothing and no audit row. */
  patchUser(id: string, patch: UserPatch, actorId: string): Promise<PatchUserResult>;
  /** Display names of the ids that exist; unknown ids are left out. */
  userNames(ids: readonly string[]): Promise<readonly { id: string; name: string }[]>;
}
