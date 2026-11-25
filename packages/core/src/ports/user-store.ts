export type Role = 'admin' | 'member' | 'viewer';

export interface UserRecord {
  readonly id: string;
  readonly descopeUserId: string;
  readonly email: string;
  readonly name: string;
  readonly avatarUrl?: string;
  readonly role: Role;
  readonly suspended: boolean;
  /** The row's `tenant_id` (docs/tenancy.md): the repository always fills it, and `legacy` is what every row that existed before tenants has; a store that knows nothing of tenants leaves it out. */
  readonly tenantId?: string;
}

/** A tenant as the first sign-in of its domain names it: the provider's id and the domain as its name. */
export interface NewTenant { readonly id: string; readonly name: string }

/** `tenant-full`: the person is new and their tenant already has its cap of people (docs/tenancy.md section 3.8); nothing is written. */
export type CreateUserResult = { kind: 'created' | 'existing'; user: UserRecord } | { kind: 'email-taken' } | { kind: 'tenant-full' };

export interface UserStore {
  findByDescopeId(descopeUserId: string): Promise<UserRecord | undefined>;
  /**
   * Insert on conflict (descope_user_id) do nothing, then read. The tenant is made first when it does not exist; without one the person joins `legacy`. A new person is
   * refused when the tenant already has the cap of people the store was made with, counted under a per-tenant lock so two sign-ins cannot both take the last place.
   */
  createIfAbsent(n: { descopeUserId: string; email: string; name: string; avatarUrl?: string; role: Role; tenant?: NewTenant }): Promise<CreateUserResult>;
  /** Used only for development tokens in local mode. Only a person of `tenantId` is changed (docs/tenancy.md section 3.2); another tenant's id answers undefined. */
  updateRole(tenantId: string, id: string, role: Role): Promise<UserRecord | undefined>;
}
