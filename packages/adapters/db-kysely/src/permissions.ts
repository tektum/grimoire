import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, sql } from 'kysely';
import type { Compilable } from 'kysely';
import type { Queryable } from '@tektum/grimoire-core/ports/database';
import type { AccessFacts, AccessOptions, AccessRequest, AccessStore, CollectionAccessRequest, CollectionFacts, Permission } from '@tektum/grimoire-core/ports/access-store';
import type { Role } from '@tektum/grimoire-core/ports/user-store';

// The SQL form of R8.9 (decision 128: the server enforces access; there is no row-level security). The decision itself is `decide` in the core;
// this file only reads facts (one statement per call, however many requests) and, for `visibleCollections`, repeats the same rule as a set query.
// The differential test in test/permissions compares both forms on random worlds.

interface AccessTables {
  users: { id: string; role: string; suspended_at: Date | null };
  group_members: { group_id: string; user_id: string };
  collections: { id: string; position: string; default_permission: string | null; deleted_at: Date | null };
  collection_access: { collection_id: string; user_id: string | null; group_id: string | null; permission: string };
  pages: { id: string; collection_id: string; state_epoch: number; deleted_at: Date | null };
}

// Only builds SQL text and parameters; the statements run on the `Queryable` the store was given, so one `query` call is one statement.
const builder = new Kysely<AccessTables>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isRole = (v: string): v is Role => (['admin', 'member', 'viewer'] as readonly string[]).includes(v);
const asPermission = (v: unknown): Permission | undefined => (v === 'read' || v === 'read_write' ? v : undefined);

async function run<Row>(db: Queryable, q: Compilable<Row>): Promise<readonly Row[]> {
  const c = q.compile();
  return db.query<Row>(c.sql, c.parameters);
}

// Raw fragments, and why: `unnest(...) with ordinality` (a table function over arrays, so N requests are one statement) and the rank of a
// permission inside `max`/`greatest`/`least` have no typed Kysely form.
const rank = (col: string) => sql<number>`(case ${sql.ref(col)} when 'read_write' then 2 when 'read' then 1 else 0 end)`;

// Correlated subqueries are raw too: Kysely cannot type references from inside a subquery to the aliases of a CTE or a join.
/** The user's own entry plus the entries of the user's groups, as the permissions of one collection (null when none). */
// The user's own entry and the entries of the user's groups are two branches, so each can use its partial unique index on collection_access and
// group_members_user_id_idx; one `or` over both made PostgreSQL scan collection_access.
const entriesOf = (collectionId: string, userId: string) => sql<string[] | null>`(
  select array_agg(e.permission) from (
    select ca.permission from collection_access ca where ca.collection_id = ${sql.ref(collectionId)} and ca.user_id = ${sql.ref(userId)}
    union all
    select ca.permission from group_members gm join collection_access ca on ca.collection_id = ${sql.ref(collectionId)} and ca.group_id = gm.group_id where gm.user_id = ${sql.ref(userId)}
  ) e)`;

interface Common { role: string | null; suspended_at: Date | null; user_found: boolean }
const userOf = (r: Common): { role: Role; suspended: boolean } | undefined => (r.user_found && r.role !== null && isRole(r.role) ? { role: r.role, suspended: r.suspended_at !== null } : undefined);
const entriesFrom = (v: readonly string[] | null): Permission[] => (v ?? []).flatMap((p) => asPermission(p) ?? []);

export function createAccessStore(db: Queryable): AccessStore {
  return {
    async facts(requests: readonly AccessRequest[]): Promise<readonly AccessFacts[]> {
      const valid = requests.flatMap((request, i) => (UUID.test(request.userId) && UUID.test(request.pageId) ? [{ request, i }] : []));
      const out: AccessFacts[] = requests.map((request) => ({ request }));
      if (valid.length === 0) return out;
      const rows = await run(db, builder
        .with('r', () => sql<{ user_id: string; page_id: string; ord: number }>`(select * from unnest(${valid.map((v) => v.request.userId)}::uuid[], ${valid.map((v) => v.request.pageId)}::uuid[]) with ordinality as t(user_id, page_id, ord))`)
        .selectFrom('r')
        .leftJoin('users as u', 'u.id', 'r.user_id')
        .leftJoin('pages as p', 'p.id', 'r.page_id')
        .leftJoin('collections as c', 'c.id', 'p.collection_id')
        .select([
          'r.ord', 'u.role', 'u.suspended_at', 'p.state_epoch', 'p.deleted_at as page_deleted_at', 'c.deleted_at as collection_deleted_at', 'c.default_permission',
          sql<boolean>`u.id is not null`.as('user_found'),
          sql<boolean>`c.id is not null`.as('page_found'),
          entriesOf('c.id', 'r.user_id').as('entries'),
        ])
        .orderBy('r.ord'));
      for (const row of rows) {
        const hit = valid[Number(row.ord) - 1];
        if (!hit) continue;
        const user = userOf(row);
        const collection = { deleted: row.collection_deleted_at !== null, defaultPermission: asPermission(row.default_permission) ?? null, entries: entriesFrom(row.entries) };
        out[hit.i] = {
          request: hit.request,
          ...(user ? { user } : {}),
          ...(row.page_found ? { page: { deleted: row.page_deleted_at !== null, epoch: row.state_epoch ?? -1, collection } } : {}),
        };
      }
      return out;
    },

    async collectionFacts(requests: readonly CollectionAccessRequest[]): Promise<readonly CollectionFacts[]> {
      const valid = requests.flatMap((request, i) => (UUID.test(request.userId) && UUID.test(request.collectionId) ? [{ request, i }] : []));
      const out: CollectionFacts[] = requests.map((request) => ({ request }));
      if (valid.length === 0) return out;
      const rows = await run(db, builder
        .with('r', () => sql<{ user_id: string; collection_id: string; ord: number }>`(select * from unnest(${valid.map((v) => v.request.userId)}::uuid[], ${valid.map((v) => v.request.collectionId)}::uuid[]) with ordinality as t(user_id, collection_id, ord))`)
        .selectFrom('r')
        .leftJoin('users as u', 'u.id', 'r.user_id')
        .leftJoin('collections as c', 'c.id', 'r.collection_id')
        .select([
          'r.ord', 'u.role', 'u.suspended_at', 'c.deleted_at as collection_deleted_at', 'c.default_permission',
          sql<boolean>`u.id is not null`.as('user_found'),
          sql<boolean>`c.id is not null`.as('collection_found'),
          entriesOf('c.id', 'r.user_id').as('entries'),
        ])
        .orderBy('r.ord'));
      for (const row of rows) {
        const hit = valid[Number(row.ord) - 1];
        if (!hit) continue;
        const user = userOf(row);
        out[hit.i] = {
          request: hit.request,
          ...(user ? { user } : {}),
          ...(row.collection_found ? { collection: { deleted: row.collection_deleted_at !== null, defaultPermission: asPermission(row.default_permission) ?? null, entries: entriesFrom(row.entries) } } : {}),
        };
      }
      return out;
    },

    async visibleCollections(userId: string, opts?: AccessOptions) {
      if (!UUID.test(userId)) return [];
      const includeDeleted = opts?.includeDeleted === true;
      // v: the best grant of the default permission and the user's entries (own and groups) per live collection; w: the role applied to it; then the filter.
      const best = sql<number>`greatest(${rank('c.default_permission')}, (
        select coalesce(max(${rank('e.permission')}), 0) from (
          select ca.permission from collection_access ca where ca.collection_id = c.id and ca.user_id = u.id
          union all
          select ca.permission from group_members gm join collection_access ca on ca.collection_id = c.id and ca.group_id = gm.group_id where gm.user_id = u.id
        ) e))`;
      const rows = await run(db, builder
        .with('v', (qc) => qc
          .selectFrom('users as u')
          .crossJoin('collections as c')
          .where('u.id', '=', userId)
          .where('u.suspended_at', 'is', null)
          .$if(!includeDeleted, (q) => q.where('c.deleted_at', 'is', null))
          .select(['c.id', 'c.position', 'u.role', best.as('best')]))
        .with('w', (qc) => qc
          .selectFrom('v')
          .select(['v.id', 'v.position', sql<number>`(case v.role when 'admin' then 2 when 'member' then v.best when 'viewer' then least(1, v.best) else 0 end)`.as('level')]))
        .selectFrom('w')
        .select(['w.id', 'w.level'])
        .where('w.level', '>', 0)
        .orderBy(sql`w.position collate "C"`)
        .orderBy('w.id'));
      return rows.map((r) => ({ collectionId: r.id, access: Number(r.level) === 2 ? ('read-write' as const) : ('read-only' as const) }));
    },
  };
}
