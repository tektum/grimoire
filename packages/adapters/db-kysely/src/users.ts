import type { CreateUserResult, Role, UserRecord, UserStore } from '@tektum/grimoire-core/ports/user-store';
import type { Queryable } from '@tektum/grimoire-core/ports/database';

type NewUser = Parameters<UserStore['createIfAbsent']>[0];
interface Row {
  id: string;
  descope_user_id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  role: Role;
  suspended_at: Date | null;
  tenant_id: string;
}
// Fixed column names, never parameterized; only user data and identifiers use placeholders.
const RECORD = 'id, descope_user_id, email, name, avatar_url, role, suspended_at, tenant_id';
const toRecord = (r: Row): UserRecord => ({
  id: r.id, descopeUserId: r.descope_user_id, email: r.email, name: r.name,
  ...(r.avatar_url === null ? {} : { avatarUrl: r.avatar_url }), role: r.role, suspended: r.suspended_at !== null, tenantId: r.tenant_id,
});
const uniqueViolation = (e: unknown): boolean => typeof e === 'object' && e !== null && 'code' in e && e.code === '23505' && 'constraint' in e && e.constraint === 'users_email_key';

export function createUserStore(db: Queryable): UserStore {
  const get = async (q: Queryable, id: string): Promise<UserRecord | undefined> => {
    const rows = await q.query<Row>(`select ${RECORD} from users where descope_user_id = $1`, [id]);
    return rows[0] ? toRecord(rows[0]) : undefined;
  };
  return {
    findByDescopeId: (id) => get(db, id),
    async createIfAbsent(input: NewUser): Promise<CreateUserResult> {
      try {
        // The tenant and the person are one statement: a refused person (the email is taken) leaves no tenant behind. The tenant is named after the domain and admits it.
        const insertUser = 'insert into users (descope_user_id, email, name, avatar_url, role, last_seen_at, tenant_id) values ($1, $2, $3, $4, $5, now(), $6) on conflict (descope_user_id) do nothing returning descope_user_id';
        const inserted = await db.query<{ descope_user_id: string }>(
          input.tenant === undefined ? insertUser : `with t as (insert into tenants (id, name, domain) values ($6, $7, $7) on conflict (id) do nothing) ${insertUser}`,
          [input.descopeUserId, input.email, input.name, input.avatarUrl ?? null, input.role, ...(input.tenant === undefined ? ['legacy'] : [input.tenant.id, input.tenant.name])],
        );
        const user = await get(db, input.descopeUserId);
        if (!user) throw new Error('users row missing after insert conflict'); // Impossible unless an out-of-band actor deletes it.
        return { kind: inserted.length === 1 ? 'created' : 'existing', user };
      } catch (e: unknown) {
        // An email race cannot be distinguished by a check first: let citext's unique constraint arbitrate, then map it to the port.
        if (uniqueViolation(e)) {
          // A concurrent first sign-in of the SAME user: its row is committed by now and the unique violation was ours on the email index (the conflict target
          // above is the subject, so a clash on the other unique index raises instead of doing nothing). The row for this subject is the answer, not a refusal.
          const same = await get(db, input.descopeUserId);
          if (same) return { kind: 'existing', user: same };
          return { kind: 'email-taken' };
        }
        throw e;
      }
    },
    async updateRole(id, role) {
      const rows = await db.query<Row>(`update users set role = $2, updated_at = now() where id = $1 returning ${RECORD}`, [id, role]);
      return rows[0] ? toRecord(rows[0]) : undefined;
    },
  };
}
