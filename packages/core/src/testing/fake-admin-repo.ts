import type { AdminRepo, AdminUser, PatchUserResult, UserListQuery, UserPatch } from '../ports/admin-repo.js';
import type { AuditEvent } from '../ports/audit-log.js';

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** In-memory AdminRepo for tests. Email order and matching ignore case, like the citext column. */
export class FakeAdminRepo implements AdminRepo {
  readonly audit: AuditEvent[] = [];
  private readonly users: AdminUser[];

  constructor(users: readonly AdminUser[] = []) {
    this.users = users.map((u) => ({ ...u }));
  }

  find(id: string): AdminUser | undefined {
    const user = this.users.find((u) => u.id === id);
    return user === undefined ? undefined : { ...user };
  }

  listUsers({ q, limit, after }: UserListQuery): Promise<readonly AdminUser[]> {
    const needle = q?.toLowerCase() ?? '';
    const key = (u: { email: string; id: string }): [string, string] => [u.email.toLowerCase(), u.id];
    const rows = this.users
      .filter((u) => needle === '' || u.email.toLowerCase().includes(needle) || u.name.toLowerCase().includes(needle))
      .filter((u) => after === undefined || compare(key(u)[0], after[0].toLowerCase()) > 0 || (key(u)[0] === after[0].toLowerCase() && compare(u.id, after[1]) > 0))
      .sort((a, b) => compare(key(a)[0], key(b)[0]) || compare(a.id, b.id));
    return Promise.resolve(rows.slice(0, limit).map((u) => ({ ...u })));
  }

  patchUser(id: string, patch: UserPatch, actorId: string): Promise<PatchUserResult> {
    const index = this.users.findIndex((u) => u.id === id);
    const before = this.users[index];
    if (before === undefined) return Promise.resolve({ kind: 'not-found' });
    const role = patch.role ?? before.role;
    const suspended = patch.suspended ?? before.suspended;
    const active = this.users.filter((u) => u.role === 'admin' && !u.suspended).length;
    if (before.role === 'admin' && !before.suspended && (role !== 'admin' || suspended) && active <= 1) return Promise.resolve({ kind: 'last-admin' });
    if (role !== before.role) this.audit.push({ actorId, action: 'user.role_changed', targetType: 'user', targetId: id, detail: { from: before.role, to: role } });
    if (suspended !== before.suspended) this.audit.push({ actorId, action: suspended ? 'user.suspended' : 'user.unsuspended', targetType: 'user', targetId: id });
    const user = { ...before, role, suspended };
    this.users[index] = user;
    return Promise.resolve({ kind: 'saved', user: { ...user } });
  }

  userNames(ids: readonly string[]): Promise<readonly { id: string; name: string }[]> {
    return Promise.resolve(this.users.filter((u) => ids.includes(u.id)).map((u) => ({ id: u.id, name: u.name })));
  }
}
