import type { CreateUserResult, Role, UserRecord, UserStore } from '@tektum/grimoire-core/ports/user-store';
import type { Database, Queryable } from '@tektum/grimoire-core/ports/database';

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

/** `maxTenantUsers`: the cap of people of one tenant (GRIMOIRE_TENANT_MAX_USERS, docs/tenancy.md section 3.8). */
export function createUserStore(db: Database, maxTenantUsers: number): UserStore {
  const get = async (q: Queryable, id: string): Promise<UserRecord | undefined> => {
    const rows = await q.query<Row>(`select ${RECORD} from users where descope_user_id = $1`, [id]);
    return rows[0] ? toRecord(rows[0]) : undefined;
  };
  return {
    findByDescopeId: (id) => get(db, id),
    async createIfAbsent(input: NewUser): Promise<CreateUserResult> {
      const tenantId = input.tenant?.id ?? 'legacy';
      try {
        return await db.transaction(async (tx): Promise<CreateUserResult> => {
          // One lock for each tenant, taken before the count is read: two first sign-ins cannot both take the last place of the cap.
          await tx.query(`select pg_advisory_xact_lock(hashtextextended('grimoire.tenants.users.' || $1::text, 0))`, [tenantId]);
          // The tenant and the person are one statement, and the tenant is made only when the person row is: a refused person (the email is taken, or the tenant is full) and the loser
          // of a race between two first sign-ins of one subject all leave no tenant behind. The tenant is named after the domain and admits it; its key is checked at the end of the statement.
          // Judged in this order, as in the fake: a person who has a row is that person (the insert below does nothing and the row is read), then an email another person has is
          // taken, then the cap. The check is here and not left to the unique index because the cap condition keeps the insert from being tried at all in a full tenant.
          const taken = await tx.query(`select 1 from users where email = $1 and descope_user_id <> $2`, [input.email, input.descopeUserId]);
          if (taken.length > 0) return { kind: 'email-taken' };
          const insertUser = `insert into users (descope_user_id, email, name, avatar_url, role, last_seen_at, tenant_id) select $1, $2, $3, $4, $5, now(), $6
            where (select count(*) from users where tenant_id = $6) < $7 on conflict (descope_user_id) do nothing returning descope_user_id`;
          const inserted = await tx.query<{ descope_user_id: string }>(
            input.tenant === undefined
              ? insertUser
              : `with u as (${insertUser}), t as (insert into tenants (id, name, domain) select $6, $8, $8 where exists (select 1 from u) on conflict (id) do nothing) select descope_user_id from u`,
            [input.descopeUserId, input.email, input.name, input.avatarUrl ?? null, input.role, tenantId, maxTenantUsers, ...(input.tenant === undefined ? [] : [input.tenant.name])],
          );
          const user = await get(tx, input.descopeUserId);
          // Nothing inserted and no row for the subject: the cap refused a new person. A person who has a row keeps it, whatever the count.
          if (!user) return { kind: 'tenant-full' };
          return { kind: inserted.length === 1 ? 'created' : 'existing', user };
        });
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
