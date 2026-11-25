import type { Database } from '@tektum/grimoire-core/ports/database';
import { EMBED_MAX_ATTEMPTS, type ChunkHit, type ChunkRow, type EmbeddingStore } from '@tektum/grimoire-core/ports/embedding-store';

/** pgvector reads a vector from its text form. */
const vectorText = (v: Float32Array): string => `[${Array.from(v).join(',')}]`;
const bytes = (b: Uint8Array): Buffer => Buffer.from(b);

/** The chunk rows of page_chunks and the state row of page_embedding_state (migration 0011): see the port for what each method means. */
export function createEmbeddingStore(db: Database): EmbeddingStore {
  return {
    async pageText(tenantId, pageId) {
      const [row] = await db.query<{ markdown_hash: Buffer; text_content: string | null }>(
        `select markdown_hash, text_content from pages where id = $1 and tenant_id = $2 and deleted_at is null and markdown_hash is not null`, [pageId, tenantId]);
      return row === undefined ? undefined : { markdownHash: new Uint8Array(row.markdown_hash), text: row.text_content ?? '' };
    },

    async existingHashes(tenantId, pageId, model) {
      const rows = await db.query<{ chunk_index: number; content_hash: Buffer }>(
        `select chunk_index, content_hash from page_chunks where page_id = $1 and tenant_id = $2 and model = $3`, [pageId, tenantId, model]);
      return new Map(rows.map((r) => [r.chunk_index, new Uint8Array(r.content_hash)]));
    },

    replacePage(tenantId, pageId, markdownHash, model, chunks: readonly ChunkRow[]) {
      return db.transaction(async (tx) => {
        // `for share`: a save of the page waits for this transaction, so the hash cannot change under it.
        const page = await tx.query<{ markdown_hash: Buffer | null }>(`select markdown_hash from pages where id = $1 and tenant_id = $2 for share`, [pageId, tenantId]);
        const current = page[0]?.markdown_hash;
        if (current === undefined || current === null || !current.equals(bytes(markdownHash))) return 'stale' as const;
        for (const c of chunks) {
          if (c.embedding !== undefined) {
            await tx.query(
              `insert into page_chunks (page_id, tenant_id, chunk_index, model, content_hash, char_start, char_end, token_count, embedding)
               values ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector)
               on conflict (page_id, chunk_index) do update set model = excluded.model, content_hash = excluded.content_hash, char_start = excluded.char_start,
                 char_end = excluded.char_end, token_count = excluded.token_count, embedding = excluded.embedding`,
              [pageId, tenantId, c.chunkIndex, model, bytes(c.contentHash), c.charStart, c.charEnd, c.tokenCount, vectorText(c.embedding)]);
          } else {
            const kept = await tx.query<{ chunk_index: number }>(
              `update page_chunks set char_start = $5, char_end = $6, token_count = $7
                where page_id = $1 and tenant_id = $2 and chunk_index = $3 and model = $8 and content_hash = $4 returning chunk_index`,
              [pageId, tenantId, c.chunkIndex, bytes(c.contentHash), c.charStart, c.charEnd, c.tokenCount, model]);
            if (kept.length === 0) throw new Error(`no stored vector to keep for chunk ${String(c.chunkIndex)}`);
          }
        }
        await tx.query(`delete from page_chunks where page_id = $1 and tenant_id = $2 and chunk_index <> all($3::int[])`, [pageId, tenantId, chunks.map((c) => c.chunkIndex)]);
        await tx.query(
          `insert into page_embedding_state (page_id, tenant_id, markdown_hash, model, status, chunk_count, attempts, error, embedded_at)
           values ($1, $2, $3, $4, 'ready', $5, 0, null, now())
           on conflict (page_id) do update set markdown_hash = excluded.markdown_hash, model = excluded.model, status = 'ready', chunk_count = excluded.chunk_count,
             attempts = 0, error = null, embedded_at = now()`,
          [pageId, tenantId, bytes(markdownHash), model, chunks.length]);
        return 'ok' as const;
      });
    },

    async markFailed(tenantId, pageId, markdownHash, model, error) {
      // The page row is read in the same statement: a page that changed since (its hash is not the one given) is left alone, and the attempts count the failures of one hash and model.
      await db.query(
        `insert into page_embedding_state (page_id, tenant_id, markdown_hash, model, status, chunk_count, attempts, error)
         select p.id, p.tenant_id, $3, $4, 'failed', 0, 1, $5 from pages p where p.id = $1 and p.tenant_id = $2 and p.markdown_hash = $3
         on conflict (page_id) do update set
           attempts = case when page_embedding_state.markdown_hash = excluded.markdown_hash and page_embedding_state.model = excluded.model then page_embedding_state.attempts + 1 else 1 end,
           markdown_hash = excluded.markdown_hash, model = excluded.model, status = 'failed', error = excluded.error`,
        [pageId, tenantId, bytes(markdownHash), model, error]);
    },

    async pagesNeedingEmbedding(tenantId, model, o) {
      const rows = await db.query<{ page_id: string; markdown_hash: Buffer }>(
        `select p.id as page_id, p.markdown_hash
           from pages p left join page_embedding_state s on s.page_id = p.id
          where p.tenant_id = $1 and p.deleted_at is null and p.markdown_hash is not null
            and coalesce(p.last_edited_at, p.updated_at) < now() - $3::int * interval '1 second'
            and (s.page_id is null or s.markdown_hash <> p.markdown_hash or s.model <> $2 or (s.status = 'failed' and s.attempts < $5))
          order by coalesce(p.last_edited_at, p.updated_at), p.id
          limit $4`,
        [tenantId, model, o.olderThanSeconds, o.limit, EMBED_MAX_ATTEMPTS]);
      return rows.map((r) => ({ pageId: r.page_id, markdownHash: new Uint8Array(r.markdown_hash) }));
    },

    async search(tenantId, queryVector, o) {
      // The 300 nearest chunks the person may read (the access predicate is inside), the nearest of each page, and the text of that chunk and the edit time of the page read from the
      // page's own row in this same statement, so nothing of a page that was filtered out is ever read (R9.32). `substr` counts code points, as the stored offsets do.
      const rows = await db.query<{ page_id: string; chunk_index: number; char_start: number; char_end: number; similarity: number; text: string | null; edited_us: string }>(
        `with nearest as (
           select c.page_id, c.chunk_index, c.char_start, c.char_end, c.embedding <=> $1::vector as distance
             from page_chunks c join pages p on p.id = c.page_id
            where c.model = $2 and c.tenant_id = $6 and p.tenant_id = $6 and p.deleted_at is null
              and p.collection_id = any($3::uuid[])
              and ($4::uuid is null or p.collection_id = $4)
              and 1 - (c.embedding <=> $1::vector) >= $5
            order by distance, c.page_id, c.chunk_index
            limit 300),
         best as (select distinct on (page_id) * from nearest order by page_id, distance, chunk_index)
         select b.page_id, b.chunk_index, b.char_start, b.char_end, 1 - b.distance as similarity,
                substr(p.text_content, b.char_start + 1, least(b.char_end - b.char_start, 4000)) as text,
                (extract(epoch from coalesce(p.last_edited_at, p.updated_at)) * 1000000)::bigint as edited_us
           from best b join pages p on p.id = b.page_id
          order by b.distance, b.page_id
          limit $7`,
        [vectorText(queryVector), o.model, [...o.collectionIds], o.collectionId ?? null, o.minSimilarity, tenantId, o.limit]);
      return rows.map((r): ChunkHit => ({
        pageId: r.page_id, chunkIndex: r.chunk_index, charStart: r.char_start, charEnd: r.char_end, similarity: Number(r.similarity), text: r.text ?? '', editedAt: Number(r.edited_us),
      }));
    },

    async counts(model) {
      const [row] = await db.query<{ chunks: number; ready: number; failed: number; pending: number }>(
        `select (select count(*)::int from page_chunks where model = $1) as chunks,
                count(*) filter (where s.model = $1 and s.markdown_hash = p.markdown_hash and s.status = 'ready')::int as ready,
                count(*) filter (where s.model = $1 and s.markdown_hash = p.markdown_hash and s.status = 'failed')::int as failed,
                count(*) filter (where s.page_id is null or s.model <> $1 or s.markdown_hash <> p.markdown_hash)::int as pending
           from pages p left join page_embedding_state s on s.page_id = p.id
          where p.deleted_at is null and p.markdown_hash is not null`, [model]);
      const counts = row as { chunks: number; ready: number; failed: number; pending: number }; // an aggregate without a group always gives one row
      return { chunks: counts.chunks, pagesReady: counts.ready, pagesFailed: counts.failed, pagesPending: counts.pending };
    },
  };
}
