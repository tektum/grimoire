import type { AttachmentRepo, AttachmentRow, CreatePendingResult } from '@tektum/grimoire-core/ports/attachment-repo';
import type { Queryable } from '@tektum/grimoire-core/ports/database';
import type { KyselyDatabase } from './index.js';

interface Row {
  id: string; page_id: string; uploader_id: string | null; file_name: string; content_type: string; size: string; s3_key: string; tenant_id: string; status: 'pending' | 'ready';
  expires_ms: string | null; created_ms: string; ready_ms: string | null;
}

/** `size` is a bigint column, which the driver gives as a string: a value no number holds exactly is refused, not rounded. */
function sizeOf(value: string): number {
  const size = Number(value);
  if (!Number.isSafeInteger(size)) throw new Error('the size of an attachment is not a safe integer');
  return size;
}
const ms = (value: string | null): number | null => (value === null ? null : Number(value));

const COLUMNS = `id, page_id, uploader_id, file_name, content_type, size::text as size, s3_key, tenant_id, status,
  (extract(epoch from expires_at) * 1000)::bigint::text as expires_ms, (extract(epoch from created_at) * 1000)::bigint::text as created_ms,
  (extract(epoch from ready_at) * 1000)::bigint::text as ready_ms`;

const record = (r: Row): AttachmentRow => ({
  id: r.id, pageId: r.page_id, uploaderId: r.uploader_id, fileName: r.file_name, contentType: r.content_type, size: sizeOf(r.size), key: r.s3_key, tenantId: r.tenant_id, status: r.status,
  expiresAt: ms(r.expires_ms), createdAt: Number(r.created_ms), readyAt: ms(r.ready_ms),
});

const isForeignKeyViolation = (e: unknown): boolean => typeof e === 'object' && e !== null && 'code' in e && e.code === '23503';
/** `deleted_at` is set by the trash purge on a row whose object it already removed but whose page was restored in between: `get` and `getMany` do not return such a row. */

/** The PostgreSQL AttachmentRepo over `attachments`. */
export function createAttachments(db: KyselyDatabase): AttachmentRepo {
  return {
    async createPending(input, cap, now) {
      try {
        return await db.transaction(async (tx): Promise<CreatePendingResult> => {
          // One user's creates run one after the other: the user's row is locked for the count and the insert (a lock that leaves other readers and the row's
          // own foreign-key checks alone), so parallel creates cannot all see room for one more.
          const user = await tx.query(`select 1 from users where id = $1 for no key update`, [input.uploaderId]);
          if (user.length === 0) return { kind: 'no-user' };
          const counted = await tx.query<{ n: number }>(
            `select count(*)::int as n from attachments where uploader_id = $1 and status = 'pending' and deleted_at is null and expires_at > to_timestamp($2::double precision / 1000.0)`,
            [input.uploaderId, now],
          );
          if ((counted[0]?.n ?? 0) >= cap) return { kind: 'cap' };
          const rows = await tx.query<Row>(
            `insert into attachments (id, page_id, uploader_id, file_name, content_type, size, s3_key, status, expires_at, tenant_id)
             values ($1, $2, $3, $4, $5, $6, $7, 'pending', to_timestamp($8::double precision / 1000.0), coalesce($9::text, (select tenant_id from pages where id = $2), 'legacy')) returning ${COLUMNS}`,
            [input.id, input.pageId, input.uploaderId, input.fileName, input.contentType, input.size, input.key, input.expiresAt, input.tenantId ?? null],
          );
          return { kind: 'created', row: record(rows[0] as Row) };
        });
      } catch (e) {
        if (isForeignKeyViolation(e)) return { kind: 'no-page' };
        throw e;
      }
    },
    async get(id) {
      const rows = await db.query<Row>(`select ${COLUMNS} from attachments where id = $1 and deleted_at is null`, [id]);
      return rows[0] === undefined ? undefined : record(rows[0]);
    },
    async getMany(ids) {
      if (ids.length === 0) return [];
      return (await db.query<Row>(`select ${COLUMNS} from attachments where id = any($1::uuid[]) and deleted_at is null`, [ids])).map(record);
    },
    async markReady(id, now) {
      const rows = await db.query<Row>(
        `update attachments set status = 'ready', ready_at = to_timestamp($2::double precision / 1000.0), expires_at = null where id = $1 and status = 'pending' and deleted_at is null and expires_at > to_timestamp($2::double precision / 1000.0) returning ${COLUMNS}`,
        [id, now],
      );
      return rows[0] === undefined ? undefined : record(rows[0]);
    },
    async remove(id) {
      await db.query(`delete from attachments where id = $1`, [id]);
    },
    async removeIfPending(id) {
      return (await db.query(`delete from attachments where id = $1 and status = 'pending' returning id`, [id])).length > 0;
    },
    async expiredPending(now, limit) {
      return (await db.query<Row>(
        `select ${COLUMNS} from attachments where status = 'pending' and expires_at < to_timestamp($1::double precision / 1000.0) order by expires_at, id limit $2`,
        [now, limit],
      )).map(record);
    },
    async insertReady(row, tx?: Queryable) {
      const rows = await (tx ?? db).query<Row>(
        `insert into attachments (id, page_id, uploader_id, file_name, content_type, size, s3_key, status, created_at, ready_at, tenant_id)
         values ($1, $2, $3, $4, $5, $6, $7, 'ready', to_timestamp($8::double precision / 1000.0), to_timestamp($8::double precision / 1000.0), coalesce((select tenant_id from pages where id = $2), 'legacy')) returning ${COLUMNS}`,
        [row.id, row.pageId, row.uploaderId, row.fileName, row.contentType, row.size, row.key, row.readyAt],
      );
      return record(rows[0] as Row);
    },
  };
}
