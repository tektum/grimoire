import type { CreateUserResult, Role, UserRecord, UserStore } from '@tektum/grimoire-core/ports/user-store';
import type { Queryable } from '@tektum/grimoire-core/ports/database';

type NewUser = { descopeUserId: string; email: string; name: string; avatarUrl?: string; role: Role };
interface Row {
  id: string;
  descope_user_id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  role: Role;
  suspended_at: Date | null;
}
// Fixed column names, never parameterized; only user data and identifiers use placeholders.
const RECORD = 'id, descope_user_id, email, name, avatar_url, role, suspended_at';
const toRecord = (r: Row): UserRecord => ({
  id: r.id, descopeUserId: r.descope_user_id, email: r.email, name: r.name,
  ...(r.avatar_url === null ? {} : { avatarUrl: r.avatar_url }), role: r.role, suspended: r.suspended_at !== null,
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
        const inserted = await db.query<{ descope_user_id: string }>(
          'insert into users (descope_user_id, email, name, avatar_url, role, last_seen_at) values ($1, $2, $3, $4, $5, now()) on conflict (descope_user_id) do nothing returning descope_user_id',
          [input.descopeUserId, input.email, input.name, input.avatarUrl ?? null, input.role],
        );
        const user = await get(db, input.descopeUserId);
        if (!user) throw new Error('users row missing after insert conflict'); // Impossible unless an out-of-band actor deletes it.
        return { kind: inserted.length === 1 ? 'created' : 'existing', user };
      } catch (e: unknown) {
        // An email race cannot be distinguished by a check first: let citext's unique constraint arbitrate, then map it to the port.
        if (uniqueViolation(e)) return { kind: 'email-taken' };
        throw e;
      }
    },
    async updateRole(id, role) {
      const rows = await db.query<Row>(`update users set role = $2, updated_at = now() where id = $1 returning ${RECORD}`, [id, role]);
      return rows[0] ? toRecord(rows[0]) : undefined;
    },
  };
}
