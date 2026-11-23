import { markdownHash } from '@tektum/grimoire-core/pages/hash';
import type { CreatePageResult, PageDetail, PageMeta, PageRepo } from '@tektum/grimoire-core/ports/page-repo';
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

        let before: string | null;
        let after: string | null;
        if (input.afterId === null) {
          before = (await tx.query<{ position: string }>(
            `select position from pages where collection_id = $1 and parent_id is not distinct from $2::uuid and deleted_at is null order by position desc limit 1`,
            [input.collectionId, input.parentId],
          ))[0]?.position ?? null;
          after = null;
        } else {
          const anchor = (await tx.query<{ position: string }>(
            `select position from pages where id = $1 and collection_id = $2 and parent_id is not distinct from $3::uuid and deleted_at is null`,
            [input.afterId, input.collectionId, input.parentId],
          ))[0];
          if (anchor === undefined) return { kind: 'no-after' };
          before = anchor.position;
          after = (await tx.query<{ position: string }>(
            `select position from pages where collection_id = $1 and parent_id is not distinct from $2::uuid and deleted_at is null and position > $3 order by position limit 1`,
            [input.collectionId, input.parentId, anchor.position],
          ))[0]?.position ?? null;
        }

        const c = input.content;
        const rows = await tx.query<Row>(
          `insert into pages (collection_id, parent_id, position, title, created_by, ydoc, ydoc_size, markdown, text_content, markdown_hash, state_epoch)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0) returning ${META_COLUMNS}`,
          [
            input.collectionId, input.parentId, position(before, after), input.title, input.createdBy,
            c === undefined ? null : Buffer.from(c.state), c === undefined ? null : c.state.length, c?.markdown ?? null, c?.text ?? null, c?.hash ?? null,
          ],
        );
        return { kind: 'created', page: meta(rows[0] as Row) };
      });
    },
    async get(id) {
      const rows = await db.query<Row & { stale_ms: string | null }>(
        `select ${META_COLUMNS}, (extract(epoch from markdown_stale_since) * 1000)::bigint::text as stale_ms
           from pages p where id = $1 and deleted_at is null and exists (select 1 from collections c where c.id = p.collection_id and c.deleted_at is null)`, [id],
      );
      const row = rows[0];
      if (row === undefined) return undefined;
      const up = await db.query<{ id: string; title: string }>(
        `with recursive up as (select id, parent_id, title, 1 as d from pages where id = $1
           union all select p.id, p.parent_id, p.title, up.d + 1 from pages p join up on p.id = up.parent_id)
         select id, title from up where id <> $2 order by d desc`, [row.parent_id, id],
      );
      const detail: PageDetail = { ...meta(row), breadcrumb: row.parent_id === null ? [] : up, markdownStaleSince: row.stale_ms === null ? null : Number(row.stale_ms) };
      return detail;
    },
    async idOfUrlId(urlId) {
      return (await db.query<{ id: string }>(`select id from pages where url_id = $1`, [urlId]))[0]?.id;
    },
    updateMeta(id, patch) {
      return db.transaction(async (tx) => {
        const row = (await tx.query<{ title: string; markdown: string | null }>(
          `select title, markdown from pages p where id = $1 and deleted_at is null and exists (select 1 from collections c where c.id = p.collection_id and c.deleted_at is null) for update`, [id],
        ))[0];
        if (row === undefined) return undefined;
        const title = patch.title ?? row.title;
        // The hash covers the title, so it moves with it: an editor save with identical content then compares equal and writes nothing.
        const hash = row.markdown === null ? null : markdownHash(title, row.markdown);
        const rows = await tx.query<Row>(
          `update pages set title = $2, icon = case when $3::boolean then $4 else icon end,
             markdown_hash = case when markdown is null then markdown_hash else $5 end, updated_at = now()
           where id = $1 returning ${META_COLUMNS}`,
          [id, title, patch.icon !== undefined, patch.icon ?? null, hash],
        );
        return meta(rows[0] as Row);
      });
    },
  };
}
