import type { Queryable } from '@tektum/grimoire-core/ports/database';
import type { RestoreResult, TrashRepo } from '@tektum/grimoire-core/ports/trash-repo';
import { insertAuditEvent } from './audit.js';
import type { KyselyDatabase } from './index.js';
import { META_COLUMNS, meta } from './pages.js';

/** A deleted page is the root of its batch when it has no parent or its parent is not in the same batch (a collection delete has many roots). */
const IS_ROOT = `p.deleted_at is not null and (p.parent_id is null or not exists (
  select 1 from pages q where q.id = p.parent_id and q.deleted_batch is not distinct from p.deleted_batch))`;

/**
 * What a purge of batch `$1` removes: the batch and every deleted page below it. A page deleted earlier, in a batch of its own, under a
 * page of this batch goes too: it could not stay, its parent row would be gone. (A live page under a deleted one cannot exist.)
 */
const DOOMED = `with recursive doomed as (
  select id from pages where deleted_batch = $1
  union select p.id from pages p join doomed d on p.parent_id = d.id where p.deleted_at is not null)`;

type MetaRow = Parameters<typeof meta>[0];

/** The PostgreSQL TrashRepo: the only place that issues `DELETE FROM pages`. */
export function createTrash(db: KyselyDatabase): TrashRepo {
  return {
    async roots(tenantId, collectionIds, limit, after) {
      const rows = await db.query<{ id: string; title: string; collection_id: string; deleted_ms: string; deleted_by: string | null }>(
        `select p.id, p.title, p.collection_id, (extract(epoch from p.deleted_at) * 1000)::bigint::text as deleted_ms, p.deleted_by
           from pages p
          where ${IS_ROOT} and p.tenant_id = $5
            and ($1::uuid[] is null or p.collection_id = any($1::uuid[]))
            and ($2::bigint is null or (extract(epoch from p.deleted_at) * 1000)::bigint < $2::bigint
                 or ((extract(epoch from p.deleted_at) * 1000)::bigint = $2::bigint and p.id < $3::uuid))
          order by (extract(epoch from p.deleted_at) * 1000)::bigint desc, p.id desc
          limit $4`,
        [collectionIds === null ? null : [...collectionIds], after === undefined ? null : String(after.deletedAt), after?.id ?? null, limit, tenantId],
      );
      return rows.map((r) => ({ id: r.id, title: r.title, collectionId: r.collection_id, deletedAt: Number(r.deleted_ms), deletedBy: r.deleted_by }));
    },

    async rootOf(tenantId, id) {
      const row = (
        await db.query<{ collection_id: string; batch: string; collection_deleted: boolean }>(
          `select p.collection_id, p.deleted_batch as batch, c.deleted_at is not null as collection_deleted
             from pages p join collections c on c.id = p.collection_id where p.id = $1 and p.tenant_id = $2 and ${IS_ROOT}`,
          [id, tenantId],
        )
      )[0];
      return row === undefined ? undefined : { id, collectionId: row.collection_id, batch: row.batch, collectionDeleted: row.collection_deleted };
    },

    restore(tenantId, id, expectedCollectionId, limits, position) {
      return db.transaction(async (tx): Promise<RestoreResult> => {
        const page = (await tx.query<{ collection_id: string }>(`select collection_id from pages p where id = $1 and tenant_id = $2 and ${IS_ROOT}`, [id, tenantId]))[0];
        if (page === undefined) return { kind: 'not-found' };
        // The caller's right was checked on this collection: a page that moved since (with an ancestor) is not restored on that check.
        if (page.collection_id !== expectedCollectionId) return { kind: 'conflict' };
        // The collection first, as create, move and delete take it, so none of them interleaves with this.
        const collection = (await tx.query<{ deleted_at: Date | null }>(`select deleted_at from collections where id = $1 for no key update`, [expectedCollectionId]))[0];
        if (collection === undefined || collection.deleted_at !== null) return { kind: 'collection-deleted' };
        // Under the lock the root is read again: another restore, a purge or a move may have come in while this one waited.
        const root = (
          await tx.query<{ collection_id: string; parent_id: string | null; position: string; deleted_batch: string }>(
            `select collection_id, parent_id, position, deleted_batch from pages p where id = $1 and ${IS_ROOT} for update`,
            [id],
          )
        )[0];
        if (root === undefined) return { kind: 'not-found' };
        if (root.collection_id !== expectedCollectionId) return { kind: 'conflict' };
        const counts = (
          await tx.query<{ live: string; batch: string }>(
            `select count(*) filter (where deleted_at is null)::text as live, count(*) filter (where deleted_batch = $2)::text as batch
             from pages where collection_id = $1 and (deleted_at is null or deleted_batch = $2)`,
            [expectedCollectionId, root.deleted_batch],
          )
        )[0];
        if (Number(counts?.live) + Number(counts?.batch) > limits.maxPages) return { kind: 'collection-full' };
        // A parent that is gone or deleted, or under which the batch would be deeper than allowed, sends the root to the top level.
        const underParent = root.parent_id === null || (await liveParentFits(tx, root.parent_id, expectedCollectionId, root.deleted_batch, id, limits.maxDepth));
        const siblings = `collection_id = $1 and parent_id is not distinct from $2::uuid and deleted_at is null`;
        const parentId = underParent ? root.parent_id : null;
        let place = root.position;
        if (!underParent) {
          const first = (await tx.query<{ position: string }>(`select position from pages where ${siblings} order by position limit 1`, [expectedCollectionId, null]))[0];
          place = position(null, first?.position ?? null);
        } else {
          const taken = await tx.query(`select 1 from pages where ${siblings} and position = $3`, [expectedCollectionId, parentId, root.position]);
          if (taken.length > 0) {
            const last = (await tx.query<{ position: string }>(`select position from pages where ${siblings} order by position desc limit 1`, [expectedCollectionId, parentId]))[0];
            place = position(last?.position ?? null, null);
          }
        }
        await tx.query(`update pages set parent_id = $2, position = $3 where id = $1`, [id, parentId, place]);
        await tx.query(`update pages set deleted_at = null, deleted_by = null, deleted_batch = null where deleted_batch = $1`, [root.deleted_batch]);
        const restored = (await tx.query<MetaRow>(`select ${META_COLUMNS} from pages where id = $1`, [id]))[0] as MetaRow;
        return { kind: 'restored', page: meta(restored) };
      });
    },

    async attachmentKeys(tenantId, batch) {
      const rows = await db.query<{ s3_key: string }>(`${DOOMED} select a.s3_key from attachments a where a.page_id in (select id from doomed) and a.tenant_id = $2 order by a.s3_key`, [batch, tenantId]);
      return rows.map((r) => r.s3_key);
    },

    async markFilesRemoved(tenantId, keys) {
      if (keys.length > 0) await db.query(`update attachments set deleted_at = now() where s3_key = any($1::text[]) and tenant_id = $2 and deleted_at is null`, [[...keys], tenantId]);
    },

    async expiredBatches(tenantId, deletedBefore, limit) {
      const rows = await db.query<{ batch: string }>(
        `select p.deleted_batch as batch from pages p
          where p.tenant_id = $1 and p.deleted_at is not null and p.deleted_batch is not null and p.deleted_at < to_timestamp($2::double precision / 1000.0)
          group by p.deleted_batch order by min(p.deleted_at), p.deleted_batch limit $3`,
        [tenantId, deletedBefore, limit],
      );
      return rows.map((r) => r.batch);
    },

    purge(tenantId, batch, actorId, removedKeys) {
      return db.transaction(async (tx) => {
        // One statement: the composite foreign key between pages is deferred, so pages that point at each other go together. `deleted_at is not
        // null` is checked on the row itself, so a restore that commits while this waits on a row lock is seen again and its pages are kept.
        const gone = await tx.query(`${DOOMED} delete from pages where id in (select id from doomed) and deleted_at is not null and tenant_id = $2 returning 1`, [batch, tenantId]);
        // Objects the caller removed whose attachment row is still here: its page came back (a restore ran in between). The row says so.
        if (removedKeys.length > 0) await tx.query(`update attachments set deleted_at = now() where s3_key = any($1::text[]) and deleted_at is null`, [[...removedKeys]]);
        if (gone.length > 0) {
          await insertAuditEvent(tx, { actorId, action: 'page.purged', targetType: 'page', targetId: batch, detail: { batch, pages: gone.length }, tenantId });
        }
        return { pages: gone.length };
      });
    },
  };
}

/** A live parent in the collection under which the root and the rest of its batch would stay within `maxDepth` levels. */
async function liveParentFits(q: Queryable, parentId: string, collectionId: string, batch: string, root: string, maxDepth: number): Promise<boolean> {
  const live = await q.query(`select 1 from pages where id = $1 and collection_id = $2 and deleted_at is null`, [parentId, collectionId]);
  if (live.length === 0) return false;
  const above = await q.query<{ depth: string }>(
    `with recursive up as (select id, parent_id, 1 as d from pages where id = $1
       union all select p.id, p.parent_id, up.d + 1 from pages p join up on p.id = up.parent_id) select max(d)::text as depth from up`,
    [parentId],
  );
  const below = await q.query<{ height: string }>(
    `with recursive down as (select id, 1 as d from pages where id = $1
       union all select p.id, down.d + 1 from pages p join down on p.parent_id = down.id where p.deleted_batch = $2) select max(d)::text as height from down`,
    [root, batch],
  );
  return Number(above[0]?.depth) + Number(below[0]?.height) <= maxDepth;
}
