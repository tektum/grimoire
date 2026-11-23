import type { TrashRepo } from '@tektum/grimoire-core/ports/trash-repo';
import { insertAuditEvent } from './audit.js';
import type { KyselyDatabase } from './index.js';
import { META_COLUMNS, meta } from './pages.js';

/** A deleted page is the root of its batch when it has no parent or its parent is not in the same batch (a collection delete has many roots). */
const IS_ROOT = `p.deleted_at is not null and (p.parent_id is null or not exists (
  select 1 from pages q where q.id = p.parent_id and q.deleted_batch is not distinct from p.deleted_batch))`;

type MetaRow = Parameters<typeof meta>[0];

/** The PostgreSQL TrashRepo: the only place that issues `DELETE FROM pages`. */
export function createTrash(db: KyselyDatabase): TrashRepo {
  return {
    async roots(collectionIds, limit, after) {
      const rows = await db.query<{ id: string; title: string; collection_id: string; deleted_ms: string; deleted_by: string | null }>(
        `select p.id, p.title, p.collection_id, (extract(epoch from p.deleted_at) * 1000)::bigint::text as deleted_ms, p.deleted_by
           from pages p
          where ${IS_ROOT}
            and ($1::uuid[] is null or p.collection_id = any($1::uuid[]))
            and ($2::bigint is null or (extract(epoch from p.deleted_at) * 1000)::bigint < $2::bigint
                 or ((extract(epoch from p.deleted_at) * 1000)::bigint = $2::bigint and p.id < $3::uuid))
          order by (extract(epoch from p.deleted_at) * 1000)::bigint desc, p.id desc
          limit $4`,
        [collectionIds === null ? null : [...collectionIds], after === undefined ? null : String(after.deletedAt), after?.id ?? null, limit],
      );
      return rows.map((r) => ({ id: r.id, title: r.title, collectionId: r.collection_id, deletedAt: Number(r.deleted_ms), deletedBy: r.deleted_by }));
    },

    async rootOf(id) {
      const row = (
        await db.query<{ collection_id: string; batch: string; collection_deleted: boolean }>(
          `select p.collection_id, p.deleted_batch as batch, c.deleted_at is not null as collection_deleted
             from pages p join collections c on c.id = p.collection_id where p.id = $1 and ${IS_ROOT}`,
          [id],
        )
      )[0];
      return row === undefined ? undefined : { id, collectionId: row.collection_id, batch: row.batch, collectionDeleted: row.collection_deleted };
    },

    restore(id, limits, position) {
      return db.transaction(async (tx) => {
        const page = (await tx.query<{ collection_id: string }>(`select collection_id from pages p where id = $1 and ${IS_ROOT}`, [id]))[0];
        if (page === undefined) return { kind: 'not-found' };
        // The collection first, as create, move and delete take it, so none of them interleaves with this.
        const collection = (await tx.query<{ deleted_at: Date | null }>(`select deleted_at from collections where id = $1 for no key update`, [page.collection_id]))[0];
        if (collection === undefined || collection.deleted_at !== null) return { kind: 'collection-deleted' };
        // Under the lock the root is read again: another restore or purge may have taken the batch while this one waited.
        const root = (
          await tx.query<{ parent_id: string | null; position: string; deleted_batch: string }>(
            `select parent_id, position, deleted_batch from pages p where id = $1 and ${IS_ROOT} for update`,
            [id],
          )
        )[0];
        if (root === undefined) return { kind: 'not-found' };
        const counts = (
          await tx.query<{ live: string; batch: string }>(
            `select count(*) filter (where deleted_at is null)::text as live, count(*) filter (where deleted_batch = $2)::text as batch
             from pages where collection_id = $1 and (deleted_at is null or deleted_batch = $2)`,
            [page.collection_id, root.deleted_batch],
          )
        )[0];
        if (Number(counts?.live) + Number(counts?.batch) > limits.maxPages) return { kind: 'collection-full' };
        const parentLive =
          root.parent_id !== null &&
          (await tx.query(`select 1 from pages where id = $1 and collection_id = $2 and deleted_at is null`, [root.parent_id, page.collection_id])).length > 0;
        const siblings = `collection_id = $1 and parent_id is not distinct from $2::uuid and deleted_at is null`;
        let parentId: string | null = null;
        let place = root.position;
        if (!parentLive) {
          // Gone or deleted parent: the top of the collection, before the first live top-level page.
          const first = (await tx.query<{ position: string }>(`select position from pages where ${siblings} order by position limit 1`, [page.collection_id, null]))[0];
          place = position(null, first?.position ?? null);
        } else {
          parentId = root.parent_id;
          const taken = await tx.query(`select 1 from pages where ${siblings} and position = $3`, [page.collection_id, parentId, root.position]);
          if (taken.length > 0) {
            const last = (
              await tx.query<{ position: string }>(`select position from pages where ${siblings} order by position desc limit 1`, [page.collection_id, parentId])
            )[0];
            place = position(last?.position ?? null, null);
          }
        }
        await tx.query(`update pages set parent_id = $2, position = $3 where id = $1`, [id, parentId, place]);
        await tx.query(`update pages set deleted_at = null, deleted_by = null, deleted_batch = null where deleted_batch = $1`, [root.deleted_batch]);
        const restored = (await tx.query<MetaRow>(`select ${META_COLUMNS} from pages where id = $1`, [id]))[0] as MetaRow;
        return { kind: 'restored', page: meta(restored) };
      });
    },

    async attachmentKeys(batch) {
      const rows = await db.query<{ s3_key: string }>(
        `select a.s3_key from attachments a join pages p on p.id = a.page_id where p.deleted_batch = $1 order by a.s3_key`,
        [batch],
      );
      return rows.map((r) => r.s3_key);
    },

    purge(batch, actorId) {
      return db.transaction(async (tx) => {
        // One statement: the composite foreign key between pages is deferred, so a batch whose pages point at each other goes together.
        const gone = await tx.query(`delete from pages where deleted_batch = $1 returning 1`, [batch]);
        if (gone.length > 0) {
          await insertAuditEvent(tx, { actorId, action: 'page.purged', targetType: 'page', targetId: batch, detail: { batch, pages: gone.length } });
        }
        return { pages: gone.length };
      });
    },
  };
}
