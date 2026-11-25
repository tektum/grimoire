import { cleanItemText, ImportBusyError, NO_IMPORT_COUNTS } from '@tektum/grimoire-core/ports/import-repo';
import type { ImportCounts, ImportItem, ImportRecord, ImportRepo } from '@tektum/grimoire-core/ports/import-repo';
import type { WriteImportedPageResult } from '@tektum/grimoire-core/ports/import-repo';
import { createAttachments } from './attachments.js';
import { scoped } from './index.js';
import type { KyselyDatabase } from './index.js';
import { openPagesOfTenant } from './pages.js';

interface ImportRow {
  id: string; tenant_id: string; status: ImportRecord['status']; source: ImportRecord['source']; target_collection_id: string; created_by: string | null;
  counts: Partial<ImportCounts> | null; error: string | null; started_ms: string | null; finished_ms: string | null; bytes: string | null; s3_key: string | null;
}

interface ItemRow {
  id: string; path: string; kind: ImportItem['kind']; status: ImportItem['status']; page_id: string | null; url_id: string | null; message: string | null;
  markdown_bytes: number | null; state_bytes: number | null; attempts: number;
}

const IMPORT_COLUMNS = `id, tenant_id, status, source, target_collection_id, created_by, counts, error, bytes::text as bytes, s3_key,
  (extract(epoch from started_at) * 1000)::bigint::text as started_ms, (extract(epoch from finished_at) * 1000)::bigint::text as finished_ms`;
const ITEM_COLUMNS = 'id::text as id, path, kind, status, page_id, url_id, message, markdown_bytes, state_bytes, attempts::int as attempts';

const ms = (value: string | null): number | null => (value === null ? null : Number(value));

const record = (r: ImportRow): ImportRecord => ({
  id: r.id, tenantId: r.tenant_id, status: r.status, source: r.source, targetCollectionId: r.target_collection_id, createdBy: r.created_by,
  counts: { ...NO_IMPORT_COUNTS, ...(r.counts ?? {}) }, error: r.error, startedAt: ms(r.started_ms), finishedAt: ms(r.finished_ms), bytes: ms(r.bytes), s3Key: r.s3_key,
});

const item = (r: ItemRow): ImportItem => ({
  id: r.id, path: r.path, kind: r.kind, status: r.status, pageId: r.page_id, urlId: r.url_id, message: r.message, markdownBytes: r.markdown_bytes, stateBytes: r.state_bytes, attempts: r.attempts,
});

/** The partial unique index of migration 0012: a tenant has one `running` import. */
const busy = (e: unknown): boolean => typeof e === 'object' && e !== null && 'code' in e && e.code === '23505' && 'constraint' in e && e.constraint === 'imports_one_running_per_tenant';

/** The PostgreSQL ImportRepo over `imports` and `import_items`: every statement names the tenant and runs scoped to it. */
export function createImportRepo(db: KyselyDatabase): ImportRepo {
  const attachments = createAttachments(db);
  return {
    async get(tenantId, id) {
      const rows = await scoped(db, tenantId).query<ImportRow>(`select ${IMPORT_COLUMNS} from imports where tenant_id = $1 and id = $2`, [tenantId, id]);
      return rows[0] === undefined ? undefined : record(rows[0]);
    },
    async addItems(tenantId, importId, items) {
      if (items.length === 0) return 0;
      // A pending page item gets its page id and URL id here (a link to a page written later points at them); every other item has neither.
      const rows = await scoped(db, tenantId).query(
        `insert into import_items (tenant_id, import_id, path, kind, status, message, page_id, url_id)
         select i.tenant_id, i.id, p.path, p.kind, p.status, p.message,
                case when p.kind = 'page' and p.status = 'pending' then gen_random_uuid() end,
                case when p.kind = 'page' and p.status = 'pending' then grimoire_url_id() end
           from imports i, unnest($3::text[], $4::text[], $5::text[], $6::text[]) as p (path, kind, status, message)
          where i.tenant_id = $1 and i.id = $2
         on conflict (import_id, path) do nothing returning 1`,
        [tenantId, importId, items.map((i) => i.path), items.map((i) => i.kind), items.map((i) => i.status ?? 'pending'), items.map((i) => (i.message === undefined ? null : cleanItemText(i.message)))],
      );
      return rows.length;
    },
    async pending(tenantId, importId, kind, limit) {
      const rows = await scoped(db, tenantId).query<ItemRow>(
        `select ${ITEM_COLUMNS} from import_items where tenant_id = $1 and import_id = $2 and kind = $3 and status = 'pending'
         order by cardinality(string_to_array(path, '/')), path collate "C" limit $4`,
        [tenantId, importId, kind, limit],
      );
      return rows.map(item);
    },
    async getItem(tenantId, importId, itemId) {
      const rows = await scoped(db, tenantId).query<ItemRow>(`select ${ITEM_COLUMNS} from import_items where tenant_id = $1 and import_id = $2 and id = $3::bigint`, [tenantId, importId, itemId]);
      return rows[0] === undefined ? undefined : item(rows[0]);
    },
    async settle(tenantId, importId, itemId, outcome) {
      const rows = await scoped(db, tenantId).query(
        `update import_items set status = $4, message = $5, markdown_bytes = $6, state_bytes = $7, page_id = null, url_id = null
         where tenant_id = $1 and import_id = $2 and id = $3::bigint and status = 'pending' returning 1`,
        [tenantId, importId, itemId, outcome.status, cleanItemText(outcome.message), outcome.markdownBytes ?? null, outcome.stateBytes ?? null],
      );
      return rows.length === 1;
    },
    writePage(tenantId, importId, page, limits, now) {
      return scoped(db, tenantId).transaction(async (tx): Promise<WriteImportedPageResult> => {
        // The collection first (as a page create does): a delete of the collection and other writes take it too, so the checks and counts below hold to the end of the transaction.
        const locked = await tx.query(`select 1 from collections where id = $1 and tenant_id = $2 and deleted_at is null for no key update`, [page.collectionId, tenantId]);
        if (locked.length === 0) return { kind: 'collection-deleted' };
        // The import, still running: its row is locked in share mode, so a cancel or a finish (which update it) wait for this write, and a write that comes after one finds the status gone.
        // A page created after the trash batch of a cancelled or failed import would stay live and escape it.
        const running = await tx.query(`select 1 from imports where tenant_id = $1 and id = $2 and status = 'running' for share`, [tenantId, importId]);
        if (running.length === 0) return { kind: 'not-running' };
        // The item, still pending and of this import: the row lock makes two writers of one item take turns, and the second finds it settled.
        const item = await tx.query<{ page_id: string | null; url_id: string | null }>(`select page_id, url_id from import_items where tenant_id = $1 and import_id = $2 and id = $3::bigint and status = 'pending' for update`, [tenantId, importId, page.itemId]);
        if (item.length === 0) return { kind: 'not-pending' };
        if (page.parentId !== null) {
          const parent = await tx.query(`select 1 from pages where id = $1 and collection_id = $2 and deleted_at is null`, [page.parentId, page.collectionId]);
          if (parent.length === 0) return { kind: 'no-parent' };
          const depth = await tx.query<{ depth: string }>(
            `with recursive up as (select id, parent_id, 1 as d from pages where id = $1
               union all select p.id, p.parent_id, up.d + 1 from pages p join up on p.id = up.parent_id)
             select max(d) as depth from up`, [page.parentId],
          );
          if (Number(depth[0]?.depth) + 1 > limits.maxDepth) return { kind: 'too-deep' };
        }
        const count = await tx.query<{ n: string }>(`select count(*) as n from pages where collection_id = $1 and deleted_at is null`, [page.collectionId]);
        if (Number(count[0]?.n) >= limits.maxPages) return { kind: 'collection-full' };
        if ((await openPagesOfTenant(tx, tenantId)) >= limits.maxTenantPages) return { kind: 'tenant-pages-full' };

        // The place among the live siblings, read under the collection lock (as a page create does): the last one's key and the open end.
        const last = await tx.query<{ position: string }>(
          `select position from pages where collection_id = $1 and parent_id is not distinct from $2::uuid and deleted_at is null order by position desc limit 1`, [page.collectionId, page.parentId],
        );
        const position = page.position(last[0]?.position ?? null, null);

        const c = page.content;
        if (c.state.length === 0) throw new Error('the editor state of an imported page cannot be empty');
        const made = await tx.query<{ id: string; url_id: string }>(
          `insert into pages (id, url_id, collection_id, parent_id, position, title, created_by, last_edited_by, last_edited_at, ydoc, ydoc_size, markdown, text_content, markdown_hash, state_epoch, tenant_id)
           values (coalesce($13::uuid, gen_random_uuid()), coalesce($14::text, grimoire_url_id()), $1::uuid, $2::uuid, $3::text, $4::text, $5::uuid, $5::uuid, to_timestamp($6::double precision / 1000.0), $7::bytea, $8::integer, $9::text, $10::text, $11::bytea, 0, $12::text)
           returning id, url_id`,
          // The page is written under the ids its item was given when it was added, so the links made to it before now hold.
          [page.collectionId, page.parentId, position, page.title, page.createdBy, now, Buffer.from(c.state), c.state.length, c.markdown, c.text, c.hash, tenantId, item[0]?.page_id ?? null, item[0]?.url_id ?? null],
        );
        const row = made[0] as { id: string; url_id: string };
        await tx.query(
          `insert into revisions (page_id, title, markdown, markdown_hash, author_ids, last_author_id, reason, created_at, tenant_id)
           values ($1::uuid, $2, $3, $4, array[$5::uuid], $5::uuid, 'import', to_timestamp($6::double precision / 1000.0), $7)`,
          [row.id, page.title, c.markdown, c.hash, page.createdBy, now, tenantId],
        );
        for (const a of page.attachments) await attachments.insertReady({ ...a, pageId: row.id }, tx);
        await tx.query(
          `update import_items set status = 'ok', page_id = $4, url_id = $5, message = null, markdown_bytes = $6, state_bytes = $7 where tenant_id = $1 and import_id = $2 and id = $3::bigint`,
          [tenantId, importId, page.itemId, row.id, row.url_id, page.markdownBytes, page.stateBytes],
        );
        return { kind: 'ok', pageId: row.id, urlId: row.url_id };
      });
    },
    async start(tenantId, id, now) {
      try {
        const rows = await scoped(db, tenantId).query<ImportRow>(
          `update imports set status = 'running', started_at = coalesce(started_at, to_timestamp($3::double precision / 1000.0))
           where tenant_id = $1 and id = $2 and status in ('uploaded', 'running') returning ${IMPORT_COLUMNS}`,
          [tenantId, id, now],
        );
        return rows[0] === undefined ? undefined : record(rows[0]);
      } catch (e) {
        // The index decides when two imports of a tenant try to run: the later one's statement fails, its row is untouched, and its job tries again.
        if (busy(e)) throw new ImportBusyError();
        throw e;
      }
    },
    async setCounts(tenantId, id, counts) {
      const rows = await scoped(db, tenantId).query(`update imports set counts = $3::jsonb where tenant_id = $1 and id = $2 and status = 'running' returning 1`, [tenantId, id, JSON.stringify(counts)]);
      return rows.length === 1;
    },
    async finish(tenantId, id, status, error, now) {
      const rows = await scoped(db, tenantId).query(
        `update imports set status = $3, error = $4, finished_at = to_timestamp($5::double precision / 1000.0) where tenant_id = $1 and id = $2 and status = 'running' returning 1`,
        [tenantId, id, status, error, now],
      );
      return rows.length === 1;
    },

    // What the routes use.
    async create(tenantId, row) {
      const rows = await scoped(db, tenantId).query<ImportRow>(
        `insert into imports (id, tenant_id, target_collection_id, created_by, source, status, s3_key, bytes) values ($1, $2, $3, $4, $5, 'created', $6, $7)
         returning ${IMPORT_COLUMNS}`,
        [row.id, tenantId, row.targetCollectionId, row.createdBy, row.source, row.s3Key, row.bytes],
      );
      return record(rows[0] as ImportRow);
    },
    async markUploaded(tenantId, id) {
      const rows = await scoped(db, tenantId).query(`update imports set status = 'uploaded' where tenant_id = $1 and id = $2 and status in ('created', 'uploaded') returning 1`, [tenantId, id]);
      return rows.length === 1;
    },
    async scanItems(tenantId, importId, options) {
      const rows = await scoped(db, tenantId).query<ItemRow>(
        `select ${ITEM_COLUMNS} from import_items where tenant_id = $1 and import_id = $2 and ($3::bigint is null or id > $3::bigint) order by import_items.id limit $4`,
        [tenantId, importId, options.afterId ?? null, options.limit],
      );
      return rows.map(item);
    },
    async listItems(tenantId, importId, options) {
      const rows = await scoped(db, tenantId).query<ItemRow>(
        `select ${ITEM_COLUMNS} from import_items where tenant_id = $1 and import_id = $2 and status <> 'pending' and ($3::bigint is null or id > $3::bigint) order by import_items.id limit $4`,
        [tenantId, importId, options.afterId ?? null, options.limit],
      );
      return rows.map(item);
    },
    async cancel(tenantId, id, now) {
      const rows = await scoped(db, tenantId).query<ImportRow>(
        `update imports set status = 'cancelled', finished_at = to_timestamp($3::double precision / 1000.0)
         where tenant_id = $1 and id = $2 and status in ('running', 'uploaded') returning ${IMPORT_COLUMNS}`,
        [tenantId, id, now],
      );
      return rows[0] === undefined ? undefined : record(rows[0]);
    },
    async running(tenantId) {
      const rows = await db.query<{ id: string }>(`select id from imports where tenant_id = $1 and status = 'running' order by id`, [tenantId]);
      return rows.map((r) => r.id);
    },
    async stale(tenantId, createdBefore, limit) {
      const rows = await db.query<{ id: string }>(
        `select id from imports where tenant_id = $1 and status in ('created', 'uploaded') and created_at <= to_timestamp($2::double precision / 1000.0)
         order by created_at, id limit $3`,
        [tenantId, createdBefore, limit],
      );
      return rows.map((r) => r.id);
    },
    async abandon(tenantId, id, now) {
      const rows = await db.query(
        `update imports set status = 'failed', error = 'abandoned', finished_at = to_timestamp($3::double precision / 1000.0)
         where tenant_id = $1 and id = $2 and status in ('created', 'uploaded') returning 1`,
        [tenantId, id, now],
      );
      return rows.length === 1;
    },
    async trashImported(tenantId, id) {
      const found = await db.query<{ created_by: string | null }>(`select created_by from imports where tenant_id = $1 and id = $2`, [tenantId, id]);
      if (found[0] === undefined) return undefined;
      return scoped(db, tenantId).transaction(async (tx) => {
        // The live pages the import's `ok` page items name, and below them every live page (one a person added under an imported page too). Each subtree is deleted under its own root's id as the batch, as a
        // page delete does, so a restore of one root checks what it must (a batch with several roots would bring the others back unchecked). A page under another imported page belongs to that page's subtree.
        const seeds = `select p.id, p.collection_id from pages p where p.tenant_id = $1 and p.deleted_at is null
          and p.id in (select page_id from import_items where tenant_id = $1 and import_id = $2 and kind = 'page' and status = 'ok' and page_id is not null)`;
        // The collections first, in id order, as create, move and a page delete take them: a create under an imported page cannot commit between this read of the tree and the delete.
        await tx.query(`select 1 from collections where id in (select collection_id from (${seeds}) s) order by id for no key update`, [tenantId, id]);
        const moved = await tx.query<{ id: string; root: string }>(
          `with recursive down as (
             select s.id, s.id as root, 0 as depth from (${seeds}) s
             union all
             select c.id, down.root, down.depth + 1 from pages c join down on c.parent_id = down.id where c.tenant_id = $1 and c.deleted_at is null),
           owned as (select distinct on (id) id, root from down order by id, depth desc)
           update pages set deleted_at = now(), deleted_by = $3, deleted_batch = owned.root
             from owned where pages.id = owned.id and pages.tenant_id = $1 and pages.deleted_at is null returning pages.id, owned.root`,
          [tenantId, id, found[0]?.created_by ?? null],
        );
        return { batches: [...new Set(moved.map((r) => r.root))], pages: moved.length };
      });
    },
  };
}
