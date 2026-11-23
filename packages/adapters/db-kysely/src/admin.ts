import type { AdminRepo, AdminUser, PatchUserResult } from '@tektum/grimoire-core/ports/admin-repo';
import type { Role } from '@tektum/grimoire-core/ports/user-store';
import { insertAuditEvent } from './audit.js';
import type { KyselyDatabase } from './index.js';

interface UserRow { id: string; email: string; name: string; role: Role; suspended: boolean }
const USER_COLUMNS = 'id, email::text as email, name, role, suspended_at is not null as suspended';
const likePattern = (q: string): string => `%${q.replace(/[\\%_]/g, '\\$&')}%`;

/** The PostgreSQL AdminRepo. */
export function createAdmin(db: KyselyDatabase): AdminRepo {
  return {
    async listUsers({ q, limit, after }) {
      const params: unknown[] = [];
      const where: string[] = [];
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
        `select ${USER_COLUMNS} from users ${where.length === 0 ? '' : `where ${where.join(' and ')}`} order by email, id limit $${String(params.length)}`, params,
      );
    },
    patchUser(id, patch, actorId) {
      return db.transaction(async (tx): Promise<PatchUserResult> => {
        // Every active administrator is locked first, in id order, so two changes that could each remove one run one after the other.
        const admins = await tx.query<{ id: string }>(`select id from users where role = 'admin' and suspended_at is null order by id for update`);
        const rows = await tx.query<UserRow>(`select ${USER_COLUMNS} from users where id = $1 for update`, [id]);
        const before = rows[0];
        if (before === undefined) return { kind: 'not-found' };
        const role = patch.role ?? before.role;
        const suspended = patch.suspended ?? before.suspended;
        const wasActiveAdmin = before.role === 'admin' && !before.suspended;
        if (wasActiveAdmin && (role !== 'admin' || suspended) && admins.length <= 1) return { kind: 'last-admin' };
        if (role === before.role && suspended === before.suspended) return { kind: 'saved', user: before };
        const saved = await tx.query<UserRow>(
          `update users set role = $2, suspended_at = case when $3::boolean then coalesce(suspended_at, now()) else null end, updated_at = now()
           where id = $1 returning ${USER_COLUMNS}`,
          [id, role, suspended],
        );
        if (role !== before.role) await insertAuditEvent(tx, { actorId, action: 'user.role_changed', targetType: 'user', targetId: id, detail: { from: before.role, to: role } });
        if (suspended !== before.suspended) {
          await insertAuditEvent(tx, { actorId, action: suspended ? 'user.suspended' : 'user.unsuspended', targetType: 'user', targetId: id });
        }
        return { kind: 'saved', user: saved[0] as UserRow };
      });
    },
    userNames(ids) {
      return db.query<{ id: string; name: string }>(`select id, name from users where id = any($1::uuid[])`, [ids]);
    },
  };
}
