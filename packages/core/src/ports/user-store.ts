export type Role = 'admin' | 'member' | 'viewer';

export interface UserRecord {
  readonly id: string;
  readonly descopeUserId: string;
  readonly email: string;
  readonly name: string;
  readonly avatarUrl?: string;
  readonly role: Role;
  readonly suspended: boolean;
  /** The row's `tenant_id` (docs/tenancy.md); a store that knows nothing of tenants leaves it out. */
  readonly tenantId?: string;
}

export type CreateUserResult = { kind: 'created' | 'existing'; user: UserRecord } | { kind: 'email-taken' };

export interface UserStore {
  findByDescopeId(descopeUserId: string): Promise<UserRecord | undefined>;
  /** Insert on conflict (descope_user_id) do nothing, then read. */
  createIfAbsent(n: { descopeUserId: string; email: string; name: string; avatarUrl?: string; role: Role }): Promise<CreateUserResult>;
  /** Used only for development tokens in local mode. */
  updateRole(id: string, role: Role): Promise<UserRecord | undefined>;
}
