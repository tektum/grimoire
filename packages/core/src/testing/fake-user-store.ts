import { randomUUID } from 'node:crypto';
import type { CreateUserResult, NewTenant, Role, UserRecord, UserStore } from '../ports/user-store.js';

/** In-memory user lifecycle for tests. Subject/id conflict rules match PostgreSQL's citext email uniqueness. */
export class FakeUserStore implements UserStore {
  private readonly users: UserRecord[] = [];
  private readonly madeTenants: NewTenant[] = [];

  /** `maxTenantUsers`: the cap of people of each tenant, as `createUserStore` takes it; none unless a test sets one. */
  constructor(rows: readonly UserRecord[] = [], private readonly maxTenantUsers = Number.POSITIVE_INFINITY) {
    for (const user of rows) this.users.push(this.copy(user));
  }

  findByDescopeId(descopeUserId: string): Promise<UserRecord | undefined> {
    return Promise.resolve(this.copy(this.users.find((u) => u.descopeUserId === descopeUserId)));
  }

  createIfAbsent(n: { descopeUserId: string; email: string; name: string; avatarUrl?: string; role: Role; tenant?: NewTenant }): Promise<CreateUserResult> {
    const existing = this.users.find((u) => u.descopeUserId === n.descopeUserId);
    if (existing) return Promise.resolve({ kind: 'existing', user: this.copy(existing) });
    if (this.users.some((u) => u.email.toLowerCase() === n.email.toLowerCase())) return Promise.resolve({ kind: 'email-taken' });
    const tenantId = n.tenant?.id ?? 'legacy';
    if (this.users.filter((u) => (u.tenantId ?? 'legacy') === tenantId).length >= this.maxTenantUsers) return Promise.resolve({ kind: 'tenant-full' });
    const user: UserRecord = { id: randomUUID(), descopeUserId: n.descopeUserId, email: n.email, name: n.name, ...(n.avatarUrl === undefined ? {} : { avatarUrl: n.avatarUrl }), role: n.role, suspended: false, ...(n.tenant === undefined ? {} : { tenantId: n.tenant.id }) };
    if (n.tenant && !this.madeTenants.some((t) => t.id === n.tenant?.id)) this.madeTenants.push({ ...n.tenant });
    this.users.push(user);
    return Promise.resolve({ kind: 'created', user: this.copy(user) });
  }

  updateRole(tenantId: string, id: string, role: Role): Promise<UserRecord | undefined> {
    const user = this.users.find((u) => u.id === id && (u.tenantId ?? 'legacy') === tenantId);
    if (!user) return Promise.resolve(undefined);
    const updated = { ...user, role };
    this.users[this.users.indexOf(user)] = updated;
    return Promise.resolve(this.copy(updated));
  }

  /** The tenants a sign-in made, in order. */
  tenants(): readonly NewTenant[] {
    return this.madeTenants.map((t) => ({ ...t }));
  }

  /** Returns test records, never the store's private references. */
  all(): readonly UserRecord[] {
    return this.users.map((user) => this.copy(user));
  }

  /** Moves the user to another tenant (the administrator's or a migration's doing), for the tests of what follows a change of tenant. */
  setTenant(descopeUserId: string, tenantId: string): boolean {
    const user = this.users.find((u) => u.descopeUserId === descopeUserId);
    if (user === undefined) return false;
    this.users[this.users.indexOf(user)] = { ...user, tenantId };
    return true;
  }

  /** Test fixture helper, deliberately not a UserStore member: sign-in never clears suspension. */
  suspend(descopeUserId: string, value = true): boolean {
    const user = this.users.find((u) => u.descopeUserId === descopeUserId);
    if (!user) return false;
    this.users[this.users.indexOf(user)] = { ...user, suspended: value };
    return true;
  }

  private copy(user: UserRecord): UserRecord;
  private copy(user: UserRecord | undefined): UserRecord | undefined;
  private copy(user: UserRecord | undefined): UserRecord | undefined {
    return user ? { ...user } : undefined;
  }
}
