import { randomUUID } from 'node:crypto';
import type { CreateUserResult, Role, UserRecord, UserStore } from '../ports/user-store.js';

/** In-memory user lifecycle for tests. Subject/id conflict rules match PostgreSQL's citext email uniqueness. */
export class FakeUserStore implements UserStore {
  private readonly users: UserRecord[] = [];

  constructor(rows: readonly UserRecord[] = []) {
    for (const user of rows) this.users.push(this.copy(user));
  }

  findByDescopeId(descopeUserId: string): Promise<UserRecord | undefined> {
    return Promise.resolve(this.copy(this.users.find((u) => u.descopeUserId === descopeUserId)));
  }

  createIfAbsent(n: { descopeUserId: string; email: string; name: string; avatarUrl?: string; role: Role }): Promise<CreateUserResult> {
    const existing = this.users.find((u) => u.descopeUserId === n.descopeUserId);
    if (existing) return Promise.resolve({ kind: 'existing', user: this.copy(existing) });
    if (this.users.some((u) => u.email.toLowerCase() === n.email.toLowerCase())) return Promise.resolve({ kind: 'email-taken' });
    const user: UserRecord = { id: randomUUID(), descopeUserId: n.descopeUserId, email: n.email, name: n.name, ...(n.avatarUrl === undefined ? {} : { avatarUrl: n.avatarUrl }), role: n.role, suspended: false };
    this.users.push(user);
    return Promise.resolve({ kind: 'created', user: this.copy(user) });
  }

  updateRole(id: string, role: Role): Promise<UserRecord | undefined> {
    const user = this.users.find((u) => u.id === id);
    if (!user) return Promise.resolve(undefined);
    const updated = { ...user, role };
    this.users[this.users.indexOf(user)] = updated;
    return Promise.resolve(this.copy(updated));
  }

  /** Returns test records, never the store's private references. */
  all(): readonly UserRecord[] {
    return this.users.map((user) => this.copy(user));
  }

  /** Test fixture helper, deliberately not a UserStore member: sign-in never clears suspension. */
  /** Moves the user to another tenant (the administrator's or a migration's doing), for the tests of what follows a change of tenant. */
  setTenant(descopeUserId: string, tenantId: string): boolean {
    const user = this.users.find((u) => u.descopeUserId === descopeUserId);
    if (user === undefined) return false;
    this.users[this.users.indexOf(user)] = { ...user, tenantId };
    return true;
  }

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
