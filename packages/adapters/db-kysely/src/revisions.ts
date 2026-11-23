import { markdownHash } from '@tektum/grimoire-core/pages/hash';
import type { CaughtUpRevision, ListedRevision, PageRevisionResult, Revision, RevisionAuthor, RevisionReason, RevisionRepo, RevisionSummary } from '@tektum/grimoire-core/ports/revision-repo';
import type { KyselyDatabase } from './index.js';

interface Row {
  id: string; created_ms: string; sort_key?: string; title: string; reason: RevisionReason; last_author_id: string | null; last_author_name: string | null;
  authors: RevisionAuthor[]; markdown?: string;
}

/** The time as whole milliseconds for the API. */
const MS = `(extract(epoch from date_trunc('milliseconds', r.created_at)) * 1000)::bigint`;
/** The exact position for the cursor: whole microseconds, so a stored time finer than a millisecond still pages without a gap or a repeat. */
const US = `(extract(epoch from r.created_at) * 1000000)::bigint`;
const COLUMNS = `r.id, ${MS}::text as created_ms, ${US}::text as sort_key, r.title, r.reason,
  lu.id as last_author_id, lu.name as last_author_name,
  (select coalesce(json_agg(json_build_object('id', u.id, 'name', u.name) order by a.ord), '[]'::json)
     from unnest(r.author_ids) with ordinality as a(id, ord) join users u on u.id = a.id) as authors`;
const FROM = `from revisions r left join users lu on lu.id = r.last_author_id`;

const summary = (r: Row): RevisionSummary => ({
  id: r.id, createdAt: Number(r.created_ms), title: r.title, reason: r.reason,
  lastAuthor: r.last_author_id === null ? null : { id: r.last_author_id, name: r.last_author_name as string }, authors: r.authors,
});

/** The PostgreSQL RevisionRepo over `revisions`. */
export function createRevisions(db: KyselyDatabase): RevisionRepo {
  return {
    async list(pageId, query) {
      // Every branch reads `revisions_page_created_idx` (page, created_at desc, id) from the cursor on: a later page does not read the earlier ones.
      const listed = (rows: readonly Row[]): ListedRevision[] => rows.map((r) => ({ ...summary(r), sortKey: Number(r.sort_key) }));
      if (query.after === undefined) {
        return listed(await db.query<Row>(`select ${COLUMNS} ${FROM} where r.page_id = $1 order by r.created_at desc, r.id limit $2`, [pageId, query.limit]));
      }
      const at = `timestamptz 'epoch' + $3::bigint * interval '1 microsecond'`;
      // The union is ordered in a wrapping select: directly on a union only output names are allowed, and the sort key is text there.
      return listed(await db.query<Row>(
        `select * from (
           (select ${COLUMNS} ${FROM} where r.page_id = $1 and r.created_at = ${at} and r.id > $4::uuid order by r.id limit $2)
           union all
           (select ${COLUMNS} ${FROM} where r.page_id = $1 and r.created_at < ${at} order by r.created_at desc, r.id limit $2)
         ) u order by u.sort_key::bigint desc, u.id limit $2`,
        [pageId, query.limit, query.after[0], query.after[1]],
      ));
    },
    async get(pageId, revisionId) {
      const rows = await db.query<Row>(`select ${COLUMNS}, r.markdown ${FROM} where r.page_id = $1 and r.id = $2`, [pageId, revisionId]);
      const row = rows[0];
      return row === undefined ? undefined : { ...summary(row), markdown: row.markdown as string } satisfies Revision;
    },
    createFromPage(request) {
      return db.transaction(async (tx): Promise<PageRevisionResult> => {
        const page = (await tx.query<{ title: string; markdown: string | null; stale: boolean }>(
          `select title, markdown, markdown_stale_since is not null as stale from pages where id = $1 and deleted_at is null for share`, [request.pageId],
        ))[0];
        if (page === undefined) return { kind: 'no-page' };
        if (page.stale) return { kind: 'stale' };
        if (page.markdown === null) return { kind: 'no-markdown' };
        const hash = markdownHash(page.title, page.markdown);
        const latest = (await tx.query<{ h: Buffer }>(`select markdown_hash as h from revisions where page_id = $1 order by created_at desc, id limit 1`, [request.pageId]))[0];
        if (latest !== undefined && Buffer.from(latest.h).equals(hash)) return { kind: 'unchanged' };
        // Authors that are not user rows are dropped (a development token's name is not a user), in the order they were given.
        const rows = await tx.query<{ id: string }>(
          `insert into revisions (page_id, title, markdown, markdown_hash, author_ids, last_author_id, reason, created_at)
           values ($1, $2, $3, $4,
             (select coalesce(array_agg(t.id order by t.ord), '{}') from unnest($5::uuid[]) with ordinality as t(id, ord) where exists (select 1 from users u where u.id = t.id)),
             (select id from users where id = $6::uuid), $7, timestamptz 'epoch' + $8::bigint * interval '1 millisecond') returning id`,
          [request.pageId, page.title, page.markdown, hash, [...request.authorIds], request.lastAuthorId, request.reason, request.at],
        );
        return { kind: 'created', id: (rows[0] as { id: string }).id };
      });
    },
    catchUp(editedBefore, limit) {
      return db.transaction(async (tx): Promise<readonly CaughtUpRevision[]> => {
        // One instance at a time: a second one waits, then finds the first one's revisions and has nothing left to make.
        await tx.query(`select pg_advisory_xact_lock(hashtext('grimoire.revisions.catch_up'))`);
        const rows = await tx.query<{ page_id: string; id: string }>(
          `insert into revisions (page_id, title, markdown, markdown_hash, author_ids, last_author_id, reason, created_at)
           select p.id, p.title, p.markdown, p.markdown_hash, case when u.id is null then '{}'::uuid[] else array[u.id] end, u.id, 'idle', p.last_edited_at
             from pages p left join users u on u.id = p.last_edited_by
            where p.deleted_at is null and p.markdown is not null and p.markdown_hash is not null and p.markdown_stale_since is null
              and p.last_edited_at is not null and p.last_edited_at < timestamptz 'epoch' + $1::bigint * interval '1 millisecond'
              and p.markdown_hash is distinct from (select r.markdown_hash from revisions r where r.page_id = p.id order by r.created_at desc, r.id limit 1)
            order by p.last_edited_at limit $2
           returning page_id, id`,
          [editedBefore, limit],
        );
        return rows.map((r) => ({ pageId: r.page_id, revisionId: r.id }));
      });
    },
  };
}
