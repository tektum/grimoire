import { randomUUID } from 'node:crypto';
import type { AdminGroup, AdminRepo, AdminUser, GroupSaveResult, MemberAddResult, PatchUserResult, UserListQuery, UserPatch } from '../ports/admin-repo.js';
import type { AuditEvent } from '../ports/audit-log.js';

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** In-memory AdminRepo for tests. Email order and matching ignore case, like the citext column. */
export class FakeAdminRepo implements AdminRepo {
  readonly audit: AuditEvent[] = [];
  private readonly users: AdminUser[];
  private readonly groups: { id: string; name: string; members: string[] }[] = [];

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

  private shown(g: { id: string; name: string; members: string[] }): AdminGroup {
    return { id: g.id, name: g.name, memberCount: g.members.length };
  }

  private taken(name: string, except?: string): boolean {
    return this.groups.some((g) => g.id !== except && g.name.toLowerCase() === name.toLowerCase());
  }

  listGroups(): Promise<readonly AdminGroup[]> {
    return Promise.resolve([...this.groups].sort((a, b) => compare(a.name.toLowerCase(), b.name.toLowerCase()) || compare(a.id, b.id)).map((g) => this.shown(g)));
  }

  createGroup(name: string, actorId: string): Promise<GroupSaveResult> {
    if (this.taken(name)) return Promise.resolve({ kind: 'name-taken' });
    const group = { id: randomUUID(), name, members: [] };
    this.groups.push(group);
    this.audit.push({ actorId, action: 'group.created', targetType: 'group', targetId: group.id });
    return Promise.resolve({ kind: 'saved', group: this.shown(group) });
  }

  renameGroup(id: string, name: string, actorId: string): Promise<GroupSaveResult> {
    const group = this.groups.find((g) => g.id === id);
    if (group === undefined) return Promise.resolve({ kind: 'not-found' });
    if (this.taken(name, id)) return Promise.resolve({ kind: 'name-taken' });
    group.name = name;
    this.audit.push({ actorId, action: 'group.renamed', targetType: 'group', targetId: id });
    return Promise.resolve({ kind: 'saved', group: this.shown(group) });
  }

  deleteGroup(id: string, actorId: string): Promise<boolean> {
    const index = this.groups.findIndex((g) => g.id === id);
    if (index < 0) return Promise.resolve(false);
    this.groups.splice(index, 1);
    this.audit.push({ actorId, action: 'group.deleted', targetType: 'group', targetId: id });
    return Promise.resolve(true);
  }

  listMembers(groupId: string): Promise<readonly AdminUser[] | undefined> {
    const group = this.groups.find((g) => g.id === groupId);
    if (group === undefined) return Promise.resolve(undefined);
    const rows = this.users.filter((u) => group.members.includes(u.id)).sort((a, b) => compare(a.email.toLowerCase(), b.email.toLowerCase()) || compare(a.id, b.id));
    return Promise.resolve(rows.map((u) => ({ ...u })));
  }

  addMember(groupId: string, userId: string, actorId: string): Promise<MemberAddResult> {
    const group = this.groups.find((g) => g.id === groupId);
    if (group === undefined) return Promise.resolve('no-group');
    if (!this.users.some((u) => u.id === userId)) return Promise.resolve('no-user');
    if (group.members.includes(userId)) return Promise.resolve('already-member');
    group.members.push(userId);
    this.audit.push({ actorId, action: 'group.member_added', targetType: 'group', targetId: groupId, detail: { userId } });
    return Promise.resolve('added');
  }

  removeMember(groupId: string, userId: string, actorId: string): Promise<boolean> {
    const group = this.groups.find((g) => g.id === groupId);
    if (group === undefined || !group.members.includes(userId)) return Promise.resolve(false);
    group.members = group.members.filter((m) => m !== userId);
    this.audit.push({ actorId, action: 'group.member_removed', targetType: 'group', targetId: groupId, detail: { userId } });
    return Promise.resolve(true);
  }
}
