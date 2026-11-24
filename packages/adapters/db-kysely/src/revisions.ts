import { markdownHash } from '@tektum/grimoire-core/pages/hash';
import type { BeforeRestoreResult, CaughtUpRevision, ListedRevision, PageRevisionResult, Revision, RevisionAuthor, RevisionReason, RevisionRepo, RevisionSummary } from '@tektum/grimoire-core/ports/revision-repo';
import type { KyselyDatabase } from './index.js';

interface Row {
  id: string; created_ms: string; sort_key?: string; title: string; reason: RevisionReason; last_author_id: string | null; last_author_name: string | null;
  authors: RevisionAuthor[]; markdown?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** One revision of one page is made at a time: a second call waits, then sees the first one's revision and finds its content unchanged. Does not block page saves. */
export const lockPage = (tx: { query(sql: string, params?: readonly unknown[]): Promise<readonly unknown[]> }, pageId: string): Promise<readonly unknown[]> =>
  tx.query(`select pg_advisory_xact_lock(hashtextextended('grimoire.revisions.page.' || $1::text, 0))`, [pageId]);

/**
 * A new revision sorts as the newest of its page: never at or before the latest revision's time. A rename changes the title (and so the content)
 * without moving the last edit, so a revision of the renamed page would otherwise tie with, or precede, the one before it, and a tie is decided by id.
 * The step is one microsecond: the API shows milliseconds, so the date a person sees stays the time of the last edit, while the order (and the
 * cursor, which is exact to the microsecond) is strict.
 */
const NEWEST = (page: string, wanted: string): string =>
  `greatest(${wanted}, (select max(r.created_at) + interval '1 microsecond' from revisions r where r.page_id = ${page}))`;

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
    async list(tenantId, pageId, query) {
      // Every branch reads `revisions_page_created_idx` (page, created_at desc, id) from the cursor on: a later page does not read the earlier ones.
      const listed = (rows: readonly Row[]): ListedRevision[] => rows.map((r) => ({ ...summary(r), sortKey: Number(r.sort_key) }));
      if (query.after === undefined) {
        return listed(await db.query<Row>(`select ${COLUMNS} ${FROM} where r.page_id = $1 and r.tenant_id = $3 order by r.created_at desc, r.id limit $2`, [pageId, query.limit, tenantId]));
      }
      const at = `timestamptz 'epoch' + $3::bigint * interval '1 microsecond'`;
      // The union is ordered in a wrapping select: directly on a union only output names are allowed, and the sort key is text there.
      return listed(await db.query<Row>(
        `select * from (
           (select ${COLUMNS} ${FROM} where r.page_id = $1 and r.tenant_id = $5 and r.created_at = ${at} and r.id > $4::uuid order by r.id limit $2)
           union all
           (select ${COLUMNS} ${FROM} where r.page_id = $1 and r.tenant_id = $5 and r.created_at < ${at} order by r.created_at desc, r.id limit $2)
         ) u order by u.sort_key::bigint desc, u.id limit $2`,
        [pageId, query.limit, query.after[0], query.after[1], tenantId],
      ));
    },
    async get(tenantId, pageId, revisionId) {
      const rows = await db.query<Row>(`select ${COLUMNS}, r.markdown ${FROM} where r.page_id = $1 and r.id = $2 and r.tenant_id = $3`, [pageId, revisionId, tenantId]);
      const row = rows[0];
      return row === undefined ? undefined : { ...summary(row), markdown: row.markdown as string } satisfies Revision;
    },
    createFromPage(request) {
      // A user id that is not a UUID (a development token's name) is no author: dropped here, before any cast.
      const authorIds = request.authorIds.filter((id) => UUID.test(id));
      const lastAuthorId = request.lastAuthorId !== null && UUID.test(request.lastAuthorId) ? request.lastAuthorId : null;
      return db.transaction(async (tx): Promise<PageRevisionResult> => {
        await lockPage(tx, request.pageId);
        const page = (await tx.query<{ title: string; markdown: string | null; stale: boolean; edited_ms: string | null; editor: string | null }>(
          `select title, markdown, markdown_stale_since is not null as stale, (extract(epoch from last_edited_at) * 1000)::bigint::text as edited_ms, last_edited_by as editor
             from pages where id = $1 and deleted_at is null for share`, [request.pageId],
        ))[0];
        if (page === undefined) return { kind: 'no-page' };
        if (page.stale) return { kind: 'stale' };
        // An edit may have been saved between the scheduler's snapshot and this read: the row says who made the last saved change and when, and the
        // revision says the same, so the Markdown it copies is never dated or attributed to an earlier edit than the one it holds.
        const savedLater = page.edited_ms !== null && Number(page.edited_ms) > request.at;
        const at = savedLater ? Number(page.edited_ms) : request.at;
        const savedBy = savedLater && page.editor !== null ? page.editor : null;
        const authors = savedBy !== null && !authorIds.includes(savedBy) ? [...authorIds, savedBy] : authorIds;
        const last = savedBy ?? lastAuthorId;
        if (page.markdown === null) return { kind: 'no-markdown' };
        const hash = markdownHash(page.title, page.markdown);
        const latest = (await tx.query<{ h: Buffer }>(`select markdown_hash as h from revisions where page_id = $1 order by created_at desc, id limit 1`, [request.pageId]))[0];
        if (latest !== undefined && Buffer.from(latest.h).equals(hash)) return { kind: 'unchanged' };
        // Authors that are not user rows are dropped (a development token's name is not a user), in the order they were given.
        const rows = await tx.query<{ id: string }>(
          `insert into revisions (page_id, title, markdown, markdown_hash, author_ids, last_author_id, reason, created_at, tenant_id)
           values ($1, $2, $3, $4,
             (select coalesce(array_agg(t.id order by t.ord), '{}') from unnest($5::uuid[]) with ordinality as t(id, ord) where exists (select 1 from users u where u.id = t.id)),
             (select id from users where id = $6::uuid), $7, ${NEWEST('$1::uuid', "timestamptz 'epoch' + $8::bigint * interval '1 millisecond'")},
             (select tenant_id from pages where id = $1)) returning id`,
          [request.pageId, page.title, page.markdown, hash, authors, last, request.reason, at],
        );
        return { kind: 'created', id: (rows[0] as { id: string }).id };
      });
    },
    catchUp(editedBefore, limit) {
      return db.transaction(async (tx): Promise<readonly CaughtUpRevision[]> => {
        // One instance at a time: a second one waits, then finds the first one's revisions and has nothing left to make.
        await tx.query(`select pg_advisory_xact_lock(hashtext('grimoire.revisions.catch_up'))`);
        const due = `p.deleted_at is null and p.markdown is not null and p.markdown_hash is not null and p.markdown_stale_since is null
              and p.last_edited_at is not null and p.last_edited_at < timestamptz 'epoch' + $1::bigint * interval '1 millisecond'
              and p.markdown_hash is distinct from (select r.markdown_hash from revisions r where r.page_id = p.id order by r.created_at desc, r.id limit 1)`;
        const candidates = await tx.query<{ id: string }>(`select p.id from pages p where ${due} order by p.last_edited_at, p.id limit $2`, [editedBefore, limit]);
        const made: CaughtUpRevision[] = [];
        // Page by page, under the page's own lock (the one `createFromPage` takes): the check against the latest revision and the insert
        // cannot interleave with another revision of the same page. The check is made again under the lock, as the page may have changed.
        for (const { id } of candidates) {
          await lockPage(tx, id);
          const rows = await tx.query<{ page_id: string; id: string }>(
            `insert into revisions (page_id, title, markdown, markdown_hash, author_ids, last_author_id, reason, created_at, tenant_id)
             select p.id, p.title, p.markdown, p.markdown_hash, case when u.id is null then '{}'::uuid[] else array[u.id] end, u.id, 'idle', ${NEWEST('p.id', 'p.last_edited_at')}, p.tenant_id
               from pages p left join users u on u.id = p.last_edited_by
              where p.id = $2 and ${due}
             returning page_id, id`,
            [editedBefore, id],
          );
          for (const r of rows) made.push({ pageId: r.page_id, revisionId: r.id });
        }
        return made;
      });
    },
    snapshotBeforeRestore(pageId) {
      return db.transaction(async (tx): Promise<BeforeRestoreResult> => {
        // Under the page's lock, as `createFromPage` and the catch-up: two safety copies of one state cannot race into two revisions.
        await lockPage(tx, pageId);
        const page = (await tx.query<{ title: string; markdown: string | null; stale: boolean; editor: string | null }>(
          `select p.title, p.markdown, (p.markdown_stale_since is not null or (p.markdown is null and p.ydoc is not null)) as stale, u.id as editor
             from pages p left join users u on u.id = p.last_edited_by where p.id = $1 and p.deleted_at is null for share of p`, [pageId],
        ))[0];
        if (page === undefined) return { kind: 'no-page' };
        if (page.stale) return { kind: 'stale' };
        if (page.markdown === null) return { kind: 'nothing-saved' };
        const hash = markdownHash(page.title, page.markdown);
        const latest = (await tx.query<{ id: string; h: Buffer }>(`select id, markdown_hash as h from revisions where page_id = $1 order by created_at desc, id limit 1`, [pageId]))[0];
        if (latest !== undefined && Buffer.from(latest.h).equals(hash)) return { kind: 'existing', id: latest.id };
        const rows = await tx.query<{ id: string }>(
          `insert into revisions (page_id, title, markdown, markdown_hash, author_ids, last_author_id, reason, created_at, tenant_id)
           select p.id, p.title, p.markdown, $2::bytea, case when u.id is null then '{}'::uuid[] else array[u.id] end, u.id, 'before_restore', ${NEWEST('p.id', 'coalesce(p.last_edited_at, now())')}, p.tenant_id
             from pages p left join users u on u.id = p.last_edited_by where p.id = $1 returning id`,
          [pageId, hash],
        );
        return { kind: 'created', id: (rows[0] as { id: string }).id };
      });
    },
  };
}
