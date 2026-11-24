export type Role = 'admin' | 'member' | 'viewer';

export interface UserRecord {
  readonly id: string;
  readonly descopeUserId: string;
  readonly email: string;
  readonly name: string;
  readonly avatarUrl?: string;
  readonly role: Role;
  readonly suspended: boolean;
  /** The workspace the person belongs to (docs/tenancy.md); `legacy` for every row that existed before tenants. */
  readonly tenantId: string;
}

/** A tenant as the first sign-in of its domain names it: the provider's id and the domain as its name. */
export interface NewTenant { readonly id: string; readonly name: string }

export type CreateUserResult = { kind: 'created' | 'existing'; user: UserRecord } | { kind: 'email-taken' };

export interface UserStore {
  findByDescopeId(descopeUserId: string): Promise<UserRecord | undefined>;
  /** Insert on conflict (descope_user_id) do nothing, then read. The tenant is made first when it does not exist; without one the person joins `legacy`. */
  createIfAbsent(n: { descopeUserId: string; email: string; name: string; avatarUrl?: string; role: Role; tenant?: NewTenant }): Promise<CreateUserResult>;
  /** Used only for development tokens in local mode. */
  updateRole(id: string, role: Role): Promise<UserRecord | undefined>;
}
