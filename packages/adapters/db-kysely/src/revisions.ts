import type { ListedRevision, Revision, RevisionAuthor, RevisionReason, RevisionRepo, RevisionSummary } from '@tektum/grimoire-core/ports/revision-repo';
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
      return listed(await db.query<Row>(
        `(select ${COLUMNS} ${FROM} where r.page_id = $1 and r.created_at = ${at} and r.id > $4::uuid order by r.id limit $2)
         union all
         (select ${COLUMNS} ${FROM} where r.page_id = $1 and r.created_at < ${at} order by r.created_at desc, r.id limit $2)
         order by sort_key::bigint desc, id limit $2`,
        [pageId, query.limit, query.after[0], query.after[1]],
      ));
    },
    async get(pageId, revisionId) {
      const rows = await db.query<Row>(`select ${COLUMNS}, r.markdown ${FROM} where r.page_id = $1 and r.id = $2`, [pageId, revisionId]);
      const row = rows[0];
      return row === undefined ? undefined : { ...summary(row), markdown: row.markdown as string } satisfies Revision;
    },
  };
}
