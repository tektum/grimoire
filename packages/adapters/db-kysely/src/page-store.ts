import { markdownHash as hashOf } from '@tektum/grimoire-core/pages/hash';
import type { Clock } from '@tektum/grimoire-core/ports/clock';
import type { PageStore, PageWrite, StoredPage, WriteOutcome } from '@tektum/grimoire-core/ports/collaboration-host';
import type { Queryable } from '@tektum/grimoire-core/ports/database';
import type { SelectType } from 'kysely';
import { scoped } from './index.js';
import type { KyselyDatabase, OperatorDatabase, PagesTable } from './index.js';

export interface PageStoreOptions {
  /** `SET LOCAL lock_timeout` of the seed and save transactions (contracts section 6: 15 s). Tests shorten it. */
  readonly lockTimeoutMs?: number;
}

type PageRow = { [K in 'title' | 'ydoc' | 'markdown' | 'markdown_hash' | 'state_epoch']: SelectType<PagesTable[K]> } & { stale_ms: number | null };

const COLUMNS = 'title, ydoc, markdown, markdown_hash, state_epoch, extract(epoch from markdown_stale_since) * 1000 as stale_ms';

/** R4.21: one hash rule for an editor save and a title change through the API. UTF-8; NUL cannot occur in a title or in Markdown, so the pair is unambiguous. */

const copy = (b: Uint8Array | null): Uint8Array | null => (b === null ? null : new Uint8Array(b));

/**
 * The locked read both `seed` and `store` start with. `lock_timeout` is an integer number of milliseconds, so it is inlined from a number, never from text.
 * The tenant is matched here as well as by `scoped()`: a page of another tenant is no row even before the policies exist.
 */
async function lockRow(tx: Queryable, tenantId: string, id: string, lockTimeoutMs: number): Promise<PageRow | undefined> {
  await tx.query(`set local lock_timeout = ${String(Math.trunc(lockTimeoutMs))}`);
  const rows = await tx.query<PageRow>(`select ${COLUMNS} from pages where id = $1 and tenant_id = $2 for update`, [id, tenantId]);
  return rows[0];
}

/**
 * `PageStore` over the `pages` table: one row per page, the Yjs state in `ydoc` and its Markdown copy beside it (contracts section 6). Every read and write
 * of a page runs scoped to the tenant it is given (the collaboration connection's, or the one `listStale` named); the list of stale pages spans every
 * tenant: it runs on `ops`, the operator connection (docs/tenancy.md section 3.2).
 */
export function createPageStore(db: KyselyDatabase, ops: OperatorDatabase, clock: Clock, options: PageStoreOptions = {}): PageStore {
  const lockTimeoutMs = options.lockTimeoutMs ?? 15_000;
  const seeding = new Map<string, Promise<{ state: Uint8Array | null; seeded: boolean; epoch: number }>>();

  /**
   * The Markdown here is converted by `reseed` (lenient limits): it must be Markdown our own serialiser stored, never user-supplied text left in a row
   * with no state (spec R7.13).
   *
   * Read, release the connection, convert with no transaction open (a heavy page must not hold a pooled connection or the row lock while it waits for the
   * converter, review F3), then write under a short locked transaction that re-checks the row: still no state, same Markdown, same epoch. Otherwise the
   * result is discarded and the row read again.
   */
  async function seedRow(tenantId: string, id: string, build: (markdown: string) => Promise<Uint8Array>): Promise<{ state: Uint8Array | null; seeded: boolean; epoch: number }> {
    const q = scoped(db, tenantId);
    for (let attempt = 0; attempt < 3; attempt++) {
      const read = (await q.query<PageRow>(`select ${COLUMNS} from pages where id = $1 and tenant_id = $2`, [id, tenantId]))[0];
      if (read === undefined) return { state: null, seeded: false, epoch: 0 };
      if (read.ydoc !== null) return { state: new Uint8Array(read.ydoc), seeded: false, epoch: read.state_epoch };
      if (read.markdown === null || read.markdown === '') return { state: null, seeded: false, epoch: read.state_epoch };
      const state = await build(read.markdown);
      const done = await q.transaction(async (tx) => {
        const row = await lockRow(tx, tenantId, id, lockTimeoutMs);
        if (row === undefined) return { state: null, seeded: false, epoch: 0 };
        if (row.ydoc !== null) return { state: new Uint8Array(row.ydoc), seeded: false, epoch: row.state_epoch };
        if (row.markdown !== read.markdown || row.state_epoch !== read.state_epoch) return undefined; // changed while converting
        await tx.query('update pages set ydoc = $2, ydoc_size = $3 where id = $1', [id, Buffer.from(state), state.byteLength]);
        return { state, seeded: true, epoch: row.state_epoch };
      });
      if (done !== undefined) return done;
    }
    throw new Error('the page kept changing while it was being seeded');
  }
  return {
    async load(tenantId, id): Promise<StoredPage | undefined> {
      const rows = await scoped(db, tenantId).query<PageRow>(`select ${COLUMNS} from pages where id = $1 and tenant_id = $2`, [id, tenantId]);
      const row = rows[0];
      if (row === undefined) return undefined;
      return { state: copy(row.ydoc), markdown: row.markdown, markdownHash: copy(row.markdown_hash), epoch: row.state_epoch, markdownStaleSince: row.stale_ms === null ? null : Number(row.stale_ms) };
    },

    seed(tenantId, id, build) {
      // One conversion per row in this process however many callers ask at once; other processes may convert too, the locked write below lets one win.
      const running = seeding.get(id);
      if (running !== undefined) return running.then((r) => ({ ...r, seeded: false })); // only the caller that did the work reports `seeded`
      const p = seedRow(tenantId, id, build).finally(() => { seeding.delete(id); });
      seeding.set(id, p);
      return p;
    },

    store(tenantId, id, w: PageWrite): Promise<WriteOutcome> {
      return scoped(db, tenantId).transaction(async (tx): Promise<WriteOutcome> => {
        const row = await lockRow(tx, tenantId, id, lockTimeoutMs);
        if (row === undefined) return { written: false, reason: 'no-row' }; // a row deleted meanwhile: nothing left to keep the state for, not a failure to retry
        if (row.state_epoch !== w.epoch) return { written: false, reason: 'epoch-mismatch' };
        const now = 'to_timestamp($2::double precision / 1000.0)';
        if (w.kind === 'state-only') {
          await tx.query(`update pages set ydoc = $3, ydoc_size = $4, updated_at = ${now}, markdown_stale_since = coalesce(markdown_stale_since, ${now}) where id = $1`, [id, clock.now(), Buffer.from(w.state), w.state.byteLength]);
          return { written: true };
        }
        const markdownHash = hashOf(row.title, w.markdown);
        if (row.stale_ms === null && row.markdown_hash !== null && Buffer.from(row.markdown_hash).equals(markdownHash)) {
          // The Markdown is as stored; skip only its columns. An edit the Markdown cannot show (trailing space, empty paragraph) is still state the clients saw (review F7).
          if (row.ydoc !== null && Buffer.from(row.ydoc).equals(Buffer.from(w.state))) return { written: false, reason: 'unchanged' };
          await tx.query(
            `update pages set ydoc = $3, ydoc_size = $4, last_edited_by = coalesce($5::uuid, last_edited_by), last_edited_at = to_timestamp($6::double precision / 1000.0), updated_at = ${now} where id = $1`,
            [id, clock.now(), Buffer.from(w.state), w.state.byteLength, w.editedBy ?? null, w.editedAt],
          );
          return { written: true };
        }
        await tx.query(
          `update pages set ydoc = $3, ydoc_size = $4, markdown = $5, text_content = $6, markdown_hash = $7,
             last_edited_by = coalesce($8::uuid, last_edited_by), last_edited_at = to_timestamp($9::double precision / 1000.0), updated_at = ${now}, markdown_stale_since = null
           where id = $1`,
          [id, clock.now(), Buffer.from(w.state), w.state.byteLength, w.markdown, w.text, markdownHash, w.editedBy ?? null, w.editedAt],
        );
        return { written: true };
      });
    },

    repairMarkdown(tenantId, id, seen, converted) {
      return scoped(db, tenantId).transaction(async (tx) => {
        const row = await lockRow(tx, tenantId, id, lockTimeoutMs);
        // Only the state the conversion was made from may get its Markdown: a save since then has a newer state, and its own Markdown or its own mark.
        if (row === undefined || row.state_epoch !== seen.epoch || row.ydoc === null || row.stale_ms === null || !Buffer.from(row.ydoc).equals(Buffer.from(seen.state))) return 'skipped';
        await tx.query(`update pages set markdown = $2, text_content = $3, markdown_hash = $4, markdown_stale_since = null where id = $1`, [id, converted.markdown, converted.text, hashOf(row.title, converted.markdown)]);
        return 'repaired';
      });
    },

    async listStale(limit) {
      const rows = await ops.transaction((tx) => tx.query<{ id: string; tenant_id: string; stale_ms: number }>('select id, tenant_id, extract(epoch from markdown_stale_since) * 1000 as stale_ms from pages where markdown_stale_since is not null order by markdown_stale_since limit $1', [limit]));
      return rows.map((r) => ({ id: r.id, tenantId: r.tenant_id, staleSince: Number(r.stale_ms) }));
    },
  };
}
