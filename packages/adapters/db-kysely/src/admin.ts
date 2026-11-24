import type { AdminGroup, AdminRepo, AdminUser, GroupSaveResult, PatchUserResult } from '@tektum/grimoire-core/ports/admin-repo';
import type { Role } from '@tektum/grimoire-core/ports/user-store';
import { insertAuditEvent } from './audit.js';
import type { KyselyDatabase } from './index.js';

interface UserRow { id: string; email: string; name: string; role: Role; suspended: boolean }
const USER_COLUMNS = 'id, email::text as email, name, role, suspended_at is not null as suspended';
const likePattern = (q: string): string => `%${q.replace(/[\\%_]/g, '\\$&')}%`;

const isUniqueViolation = (e: unknown): boolean => typeof e === 'object' && e !== null && 'code' in e && e.code === '23505';
const GROUP_SELECT = `select g.id, g.name::text as name, (select count(*)::int from group_members m where m.group_id = g.id) as "memberCount" from groups g`;

/** The PostgreSQL AdminRepo. */
export function createAdmin(db: KyselyDatabase): AdminRepo {
  return {
    async listUsers(tenantId, { q, limit, after }) {
      const params: unknown[] = [tenantId];
      const where: string[] = ['tenant_id = $1'];
      if (q !== undefined && q !== '') {
        params.push(likePattern(q));
        where.push(`(email ilike $${String(params.length)} or name ilike $${String(params.length)})`);
      }
      if (after !== undefined) {
        params.push(after[0], after[1]);
        where.push(`(email, id) > ($${String(params.length - 1)}::citext, $${String(params.length)}::uuid)`);
      }
      params.push(limit);
      return db.query<AdminUser>(
        `select ${USER_COLUMNS} from users where ${where.join(' and ')} order by email, id limit $${String(params.length)}`, params,
      );
    },
    patchUser(tenantId, id, patch, actorId) {
      return db.transaction(async (tx): Promise<PatchUserResult> => {
        // Every active administrator of the tenant is locked first, in id order, so two changes that could each remove one run one after the other. The last administrator is
        // the last of the tenant: another tenant's administrators neither count nor wait.
        const admins = await tx.query<{ id: string }>(`select id from users where role = 'admin' and suspended_at is null and tenant_id = $1 order by id for update`, [tenantId]);
        const rows = await tx.query<UserRow>(`select ${USER_COLUMNS} from users where id = $1 and tenant_id = $2 for update`, [id, tenantId]);
        const before = rows[0];
        if (before === undefined) return { kind: 'not-found' };
        const role = patch.role ?? before.role;
        const suspended = patch.suspended ?? before.suspended;
        const wasActiveAdmin = before.role === 'admin' && !before.suspended;
        if (wasActiveAdmin && (role !== 'admin' || suspended) && admins.length <= 1) return { kind: 'last-admin' };
        if (role === before.role && suspended === before.suspended) return { kind: 'saved', user: before };
        const saved = await tx.query<UserRow>(
          `update users set role = $2, suspended_at = case when $3::boolean then coalesce(suspended_at, now()) else null end, updated_at = now()
           where id = $1 and tenant_id = $4 returning ${USER_COLUMNS}`,
          [id, role, suspended, tenantId],
        );
        if (role !== before.role) await insertAuditEvent(tx, { actorId, action: 'user.role_changed', targetType: 'user', targetId: id, detail: { from: before.role, to: role } });
        if (suspended !== before.suspended) {
          await insertAuditEvent(tx, { actorId, action: suspended ? 'user.suspended' : 'user.unsuspended', targetType: 'user', targetId: id });
        }
        return { kind: 'saved', user: saved[0] as UserRow };
      });
    },
    userNames(tenantId, ids) {
      return db.query<{ id: string; name: string }>(`select id, name from users where id = any($1::uuid[]) and tenant_id = $2`, [ids, tenantId]);
    },
    listGroups(tenantId) {
      return db.query<AdminGroup>(`${GROUP_SELECT} where g.tenant_id = $1 order by g.name, g.id`, [tenantId]);
    },
    async createGroup(tenantId, name, actorId) {
      try {
        return await db.transaction(async (tx): Promise<GroupSaveResult> => {
          const made = await tx.query<{ id: string }>(`insert into groups (name, tenant_id) values ($1, $2) returning id`, [name, tenantId]);
          const groupId = (made[0] as { id: string }).id;
          await insertAuditEvent(tx, { actorId, action: 'group.created', targetType: 'group', targetId: groupId });
          return { kind: 'saved', group: (await tx.query<AdminGroup>(`${GROUP_SELECT} where g.id = $1`, [groupId]))[0] as AdminGroup };
        });
      } catch (e) {
        if (isUniqueViolation(e)) return { kind: 'name-taken' };
        throw e;
      }
    },
    async renameGroup(tenantId, groupId, name, actorId) {
      try {
        return await db.transaction(async (tx): Promise<GroupSaveResult> => {
          const found = await tx.query(`select 1 from groups where id = $1 and tenant_id = $2 for update`, [groupId, tenantId]);
          if (found.length === 0) return { kind: 'not-found' };
          await tx.query(`update groups set name = $2, updated_at = now() where id = $1`, [groupId, name]);
          await insertAuditEvent(tx, { actorId, action: 'group.renamed', targetType: 'group', targetId: groupId });
          return { kind: 'saved', group: (await tx.query<AdminGroup>(`${GROUP_SELECT} where g.id = $1`, [groupId]))[0] as AdminGroup };
        });
      } catch (e) {
        if (isUniqueViolation(e)) return { kind: 'name-taken' };
        throw e;
      }
    },
    deleteGroup(tenantId, groupId, actorId) {
      return db.transaction(async (tx) => {
        // The members and the collection access entries of the group go with it (foreign keys on delete cascade).
        const removed = await tx.query(`delete from groups where id = $1 and tenant_id = $2 returning id`, [groupId, tenantId]);
        if (removed.length === 0) return false;
        await insertAuditEvent(tx, { actorId, action: 'group.deleted', targetType: 'group', targetId: groupId });
        return true;
      });
    },
    async listMembers(tenantId, groupId) {
      const found = await db.query(`select 1 from groups where id = $1 and tenant_id = $2`, [groupId, tenantId]);
      if (found.length === 0) return undefined;
      return db.query<AdminUser>(
        `select u.id, u.email::text as email, u.name, u.role, u.suspended_at is not null as suspended
         from group_members m join users u on u.id = m.user_id where m.group_id = $1 order by u.email, u.id`, [groupId],
      );
    },
    addMember(tenantId, groupId, userId, actorId) {
      return db.transaction(async (tx) => {
        if ((await tx.query(`select 1 from groups where id = $1 and tenant_id = $2 for share`, [groupId, tenantId])).length === 0) return 'no-group' as const;
        if ((await tx.query(`select 1 from users where id = $1 and tenant_id = $2`, [userId, tenantId])).length === 0) return 'no-user' as const;
        const added = await tx.query(`insert into group_members (group_id, user_id, tenant_id) values ($1, $2, $3) on conflict do nothing returning user_id`, [groupId, userId, tenantId]);
        if (added.length === 0) return 'already-member' as const;
        await insertAuditEvent(tx, { actorId, action: 'group.member_added', targetType: 'group', targetId: groupId, detail: { userId } });
        return 'added' as const;
      });
    },
    removeMember(tenantId, groupId, userId, actorId) {
      return db.transaction(async (tx) => {
        const removed = await tx.query(`delete from group_members where group_id = $1 and user_id = $2 and tenant_id = $3 returning user_id`, [groupId, userId, tenantId]);
        if (removed.length === 0) return false;
        await insertAuditEvent(tx, { actorId, action: 'group.member_removed', targetType: 'group', targetId: groupId, detail: { userId } });
        return true;
      });
    },
  };
}
