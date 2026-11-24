import { markdownHash } from '@tektum/grimoire-core/pages/hash';
import type { Queryable } from '@tektum/grimoire-core/ports/database';
import type { CreatePageResult, MovePageResult, PageDetail, PageMeta, PageRepo, SoftDeleteResult } from '@tektum/grimoire-core/ports/page-repo';
import type { KyselyDatabase } from './index.js';

interface Row {
  id: string; url_id: string; collection_id: string; parent_id: string | null; position: string; title: string; icon: string | null;
  created_by: string; last_edited_by: string | null; last_edited_ms: string | null; saved_ms: string; state_epoch: number;
}

/** The columns of a page's meta; times as epoch milliseconds. */
export const META_COLUMNS = `id, url_id, collection_id, parent_id, position, title, icon, created_by, last_edited_by,
  (extract(epoch from last_edited_at) * 1000)::bigint::text as last_edited_ms, (extract(epoch from updated_at) * 1000)::bigint::text as saved_ms, state_epoch`;

export const meta = (r: Row): PageMeta => ({
  id: r.id, urlId: r.url_id, collectionId: r.collection_id, parentId: r.parent_id, position: r.position, title: r.title, icon: r.icon,
  createdBy: r.created_by, lastEditedBy: r.last_edited_by, lastEditedAt: r.last_edited_ms === null ? null : Number(r.last_edited_ms),
  savedAt: Number(r.saved_ms), stateEpoch: r.state_epoch,
});

const MOVE_ATTEMPTS = 3;
const isSerializationFailure = (e: unknown): boolean => typeof e === 'object' && e !== null && 'code' in e && (e.code === '40001' || e.code === '40P01');

/** A page id that no page has: the neighbours of a page that is not made yet leave nothing out. */
const NO_PAGE = '00000000-0000-0000-0000-000000000000';

/**
 * Positions of the live siblings around the new place: after `afterId`, before `beforeId`, or last. Undefined when the sibling asked for is not one
 * (another parent, another collection, deleted, or the page itself).
 */
async function neighbours(tx: Queryable, collectionId: string, parentId: string | null, afterId: string | null, beforeId: string | null, selfId: string): Promise<{ before: string | null; after: string | null } | undefined> {
  const siblings = `collection_id = $1 and parent_id is not distinct from $2::uuid and deleted_at is null and id <> $3`;
  if (beforeId !== null) {
    const anchor = (await tx.query<{ position: string }>(`select position from pages where ${siblings} and id = $4`, [collectionId, parentId, selfId, beforeId]))[0];
    if (anchor === undefined) return undefined;
    const previous = await tx.query<{ position: string }>(`select position from pages where ${siblings} and position < $4 order by position desc limit 1`, [collectionId, parentId, selfId, anchor.position]);
    return { before: previous[0]?.position ?? null, after: anchor.position };
  }
  if (afterId === null) {
    const last = await tx.query<{ position: string }>(`select position from pages where ${siblings} order by position desc limit 1`, [collectionId, parentId, selfId]);
    return { before: last[0]?.position ?? null, after: null };
  }
  const anchor = (await tx.query<{ position: string }>(`select position from pages where ${siblings} and id = $4`, [collectionId, parentId, selfId, afterId]))[0];
  if (anchor === undefined) return undefined;
  const next = await tx.query<{ position: string }>(`select position from pages where ${siblings} and position > $4 order by position limit 1`, [collectionId, parentId, selfId, anchor.position]);
  return { before: anchor.position, after: next[0]?.position ?? null };
}

/** The PostgreSQL PageRepo over `pages`. */
export function createPages(db: KyselyDatabase): PageRepo {
  return {
    create(input, limits, position) {
      return db.transaction(async (tx): Promise<CreatePageResult> => {
        // The collection row first: a delete of the collection and other creates take it too, so the liveness check, the count and the
        // sibling positions below cannot change under this transaction.
        const locked = await tx.query(`select 1 from collections where id = $1 and deleted_at is null for no key update`, [input.collectionId]);
        if (locked.length === 0) return { kind: 'collection-deleted' };
        if (input.parentId !== null) {
          const parent = await tx.query(`select 1 from pages where id = $1 and collection_id = $2 and deleted_at is null`, [input.parentId, input.collectionId]);
          if (parent.length === 0) return { kind: 'no-parent' };
          const depth = await tx.query<{ depth: string }>(
            `with recursive up as (select id, parent_id, 1 as d from pages where id = $1
               union all select p.id, p.parent_id, up.d + 1 from pages p join up on p.id = up.parent_id)
             select max(d) as depth from up`, [input.parentId],
          );
          if (Number(depth[0]?.depth) + 1 > limits.maxDepth) return { kind: 'too-deep' };
        }
        const count = await tx.query<{ n: string }>(`select count(*) as n from pages where collection_id = $1 and deleted_at is null`, [input.collectionId]);
        if (Number(count[0]?.n) >= limits.maxPages) return { kind: 'collection-full' };

        const around = await neighbours(tx, input.collectionId, input.parentId, input.afterId, input.beforeId ?? null, NO_PAGE);
        if (around === undefined) return { kind: 'no-after' };
        const { before, after } = around;

        const c = input.content;
        // Markdown is stored only with a non-empty editor state, checked in the statement that writes both (R7.13).
        const rows = await tx.query<Row>(
          `insert into pages (collection_id, parent_id, position, title, created_by, ydoc, ydoc_size, markdown, text_content, markdown_hash, state_epoch)
           select $1::uuid, $2::uuid, $3::text, $4::text, $5::uuid, $6::bytea, $7::integer, $8::text, $9::text, $10::bytea, 0 where $6::bytea is null or octet_length($6::bytea) > 0 returning ${META_COLUMNS}`,
          [
            input.collectionId, input.parentId, position(before, after), input.title, input.createdBy,
            c === undefined ? null : Buffer.from(c.state), c === undefined ? null : c.state.length, c?.markdown ?? null, c?.text ?? null, c?.hash ?? null,
          ],
        );
        if (rows.length === 0) throw new Error('the editor state of a page with Markdown cannot be empty');
        return { kind: 'created', page: meta(rows[0] as Row) };
      });
    },
    async get(id) {
      const rows = await db.query<Row & { stale_ms: string | null; stale: boolean }>(
        `select ${META_COLUMNS}, (extract(epoch from markdown_stale_since) * 1000)::bigint::text as stale_ms,
                (markdown_stale_since is not null or (markdown is null and ydoc is not null)) as stale
           from pages p where id = $1 and deleted_at is null and exists (select 1 from collections c where c.id = p.collection_id and c.deleted_at is null)`, [id],
      );
      const row = rows[0];
      if (row === undefined) return undefined;
      const up = await db.query<{ id: string; title: string }>(
        `with recursive up as (select id, parent_id, title, 1 as d from pages where id = $1
           union all select p.id, p.parent_id, p.title, up.d + 1 from pages p join up on p.id = up.parent_id)
         select id, title from up where id <> $2 order by d desc`, [row.parent_id, id],
      );
      const detail: PageDetail = { ...meta(row), breadcrumb: row.parent_id === null ? [] : up, markdownStaleSince: row.stale_ms === null ? null : Number(row.stale_ms), markdownStale: row.stale };
      return detail;
    },
    async markdownOf(id) {
      const rows = await db.query<{ markdown: string | null; has_state: boolean; title: string; saved_ms: string; stale_ms: string | null }>(
        `select markdown, ydoc is not null as has_state, title, (extract(epoch from updated_at) * 1000)::bigint::text as saved_ms,
                (extract(epoch from markdown_stale_since) * 1000)::bigint::text as stale_ms
           from pages p where id = $1 and deleted_at is null and exists (select 1 from collections c where c.id = p.collection_id and c.deleted_at is null)`, [id],
      );
      const row = rows[0];
      if (row === undefined) return undefined;
      return { markdown: row.markdown, hasState: row.has_state, title: row.title, savedAt: Number(row.saved_ms), markdownStaleSince: row.stale_ms === null ? null : Number(row.stale_ms) };
    },
    async idOfUrlId(urlId) {
      return (await db.query<{ id: string }>(`select id from pages where url_id = $1`, [urlId]))[0]?.id;
    },
    updateMeta(id, patch) {
      return db.transaction(async (tx) => {
        const retitled = patch.title !== undefined;
        // The Markdown is read, and the title and hash written, only when the title changes: an icon change must not rebuild the search vector.
        const row = (await tx.query<{ markdown?: string | null }>(
          `select ${retitled ? 'markdown' : '1 as one'} from pages p where id = $1 and deleted_at is null
             and exists (select 1 from collections c where c.id = p.collection_id and c.deleted_at is null) for update`, [id],
        ))[0];
        if (row === undefined) return undefined;
        const sets = ['updated_at = now()'];
        const params: unknown[] = [id];
        if (patch.icon !== undefined) {
          params.push(patch.icon);
          sets.push(`icon = $${String(params.length)}`);
        }
        if (retitled && patch.title !== undefined) {
          params.push(patch.title);
          sets.push(`title = $${String(params.length)}`);
          if (row.markdown !== undefined && row.markdown !== null) {
            // The hash covers the title, so it moves with it: an editor save with identical content then compares equal and writes nothing.
            params.push(markdownHash(patch.title, row.markdown));
            sets.push(`markdown_hash = $${String(params.length)}`);
          }
        }
        const rows = await tx.query<Row>(`update pages set ${sets.join(', ')} where id = $1 returning ${META_COLUMNS}`, params);
        return meta(rows[0] as Row);
      });
    },
    async move(id, to, limits, position) {
      for (let attempt = 1; attempt <= MOVE_ATTEMPTS; attempt += 1) {
        try {
          return await db.transaction(async (tx): Promise<MovePageResult> => {
            await tx.query(`set transaction isolation level serializable`);
            const page = (await tx.query<{ collection_id: string }>(`select collection_id from pages where id = $1 and deleted_at is null`, [id]))[0];
            if (page === undefined) return { kind: 'not-found' };
            // Access was checked against this collection; a page that left it since is not moved on that check.
            if (page.collection_id !== to.expectedCollectionId) return { kind: 'conflict' };
            const target = to.collectionId ?? page.collection_id;
            // The collections first, in id order, as `create` takes them: moves, creates and deletes of a collection run one at a time.
            const locked = await tx.query<{ id: string; deleted_at: Date | null }>(
              `select id, deleted_at from collections where id = any($1::uuid[]) order by id for no key update`, [[...new Set([page.collection_id, target])]],
            );
            if (locked.find((c) => c.id === page.collection_id)?.deleted_at !== null) return { kind: 'not-found' };
            if (locked.find((c) => c.id === target)?.deleted_at !== null) return { kind: 'collection-deleted' };
            const row = await tx.query(`select 1 from pages where id = $1 and collection_id = $2 and deleted_at is null for update`, [id, page.collection_id]);
            if (row.length === 0) return { kind: 'not-found' };

            let parentDepth = 0;
            if (to.parentId !== null) {
              const parent = await tx.query(`select 1 from pages where id = $1 and collection_id = $2 and deleted_at is null`, [to.parentId, target]);
              if (parent.length === 0) return { kind: 'no-parent' };
              // The ancestors of the new parent, itself included: the page among them means the target is the page or lies inside its subtree.
              const up = await tx.query<{ id: string; d: number }>(
                `with recursive up as (select id, parent_id, 1 as d from pages where id = $1
                   union all select p.id, p.parent_id, up.d + 1 from pages p join up on p.id = up.parent_id) select id, d from up`, [to.parentId],
              );
              if (up.some((r) => r.id === id)) return { kind: 'would-create-cycle' };
              parentDepth = Math.max(...up.map((r) => Number(r.d)));
            }
            const live = await tx.query<{ height: number; size: string }>(
              `with recursive down as (select id, 1 as d from pages where id = $1
                 union all select p.id, down.d + 1 from pages p join down on p.parent_id = down.id where p.deleted_at is null)
               select max(d) as height, count(*) as size from down`, [id],
            );
            if (parentDepth + Number(live[0]?.height) > limits.maxDepth) return { kind: 'too-deep' };
            if (target !== page.collection_id) {
              const count = await tx.query<{ n: string }>(`select count(*) as n from pages where collection_id = $1 and deleted_at is null`, [target]);
              if (Number(count[0]?.n) + Number(live[0]?.size) > limits.maxPages) return { kind: 'collection-full' };
            }
            const around = await neighbours(tx, target, to.parentId, to.afterId, to.beforeId ?? null, id);
            if (around === undefined) return { kind: 'no-after' };

            // One statement for the page and every descendant, deleted ones too: the composite foreign key (parent, collection) is checked when it commits.
            await tx.query(
              `with recursive down as (select id from pages where id = $1 union all select p.id from pages p join down on p.parent_id = down.id)
               update pages set collection_id = $2, parent_id = case when id = $1 then $3::uuid else parent_id end,
                 position = case when id = $1 then $4 else position end, updated_at = case when id = $1 then now() else updated_at end
               where id in (select id from down)`,
              [id, target, to.parentId, position(around.before, around.after)],
            );
            const rows = await tx.query<Row>(`select ${META_COLUMNS} from pages where id = $1`, [id]);
            return { kind: 'moved', page: meta(rows[0] as Row) };
          });
        } catch (e) {
          if (!isSerializationFailure(e)) throw e;
        }
      }
      return { kind: 'conflict' };
    },
    softDelete(id, deletedBy, expectedCollectionId) {
      return db.transaction(async (tx): Promise<SoftDeleteResult> => {
        const page = (await tx.query<{ collection_id: string }>(`select collection_id from pages where id = $1 and deleted_at is null`, [id]))[0];
        if (page === undefined) return { kind: 'not-found' };
        // Access was checked against this collection; a page that left it since is not deleted on that check.
        if (page.collection_id !== expectedCollectionId) return { kind: 'conflict' };
        // The collection first, as create and move take it: a delete of the collection, a move and a create cannot interleave with this.
        const live = await tx.query(`select 1 from collections where id = $1 and deleted_at is null for no key update`, [expectedCollectionId]);
        if (live.length === 0) return { kind: 'not-found' };
        // A move that committed between the first read and the lock is seen here, under the lock.
        const still = (await tx.query<{ collection_id: string; deleted_at: Date | null }>(`select collection_id, deleted_at from pages where id = $1 for update`, [id]))[0];
        // Deleted by another request while this one waited: it is in the trash, not moved. Only a changed collection is a conflict.
        if (still === undefined || still.deleted_at !== null) return { kind: 'not-found' };
        if (still.collection_id !== expectedCollectionId) return { kind: 'conflict' };
        const deleted = await tx.query(
          `with recursive down as (select id from pages where id = $1 and deleted_at is null
             union all select p.id from pages p join down on p.parent_id = down.id where p.deleted_at is null)
           update pages set deleted_at = now(), deleted_by = $2, deleted_batch = $1 where id in (select id from down) and deleted_at is null returning 1`,
          [id, deletedBy],
        );
        return { kind: 'deleted', pages: deleted.length };
      });
    },
  };
}
