/** A page that failed to embed this many times at one Markdown hash and one model is not tried again until its Markdown (or the model) changes. */
export const EMBED_MAX_ATTEMPTS = 3;

/** One chunk of a page, as it is stored. */
export interface ChunkRow {
  readonly chunkIndex: number;
  /** SHA-256 of the chunk's text (32 bytes): an unchanged chunk keeps its vector when the page is embedded again. */
  readonly contentHash: Uint8Array;
  /** Offsets of the chunk in the page's text, in UTF-16 code units. */
  readonly charStart: number;
  readonly charEnd: number;
  readonly tokenCount: number;
  /** L2-normalised, of the dimension of the model. Absent for a chunk that did not change (same index and same `contentHash` as `existingHashes` said): the stored vector is kept and the offsets are updated. */
  readonly embedding?: Float32Array;
}

export interface ChunkHit {
  readonly pageId: string;
  readonly chunkIndex: number;
  readonly charStart: number;
  readonly charEnd: number;
  /** Cosine similarity, 1 for the same direction. */
  readonly similarity: number;
}

/**
 * The chunks and the embedding state of pages (migration 0011), for the jobs that make them and the search that reads them. Every method works inside one tenant
 * (docs/tenancy.md: the tenant comes first, as in the other repositories), and a page of another tenant is not there. `counts` is the one exception: it is the operator's
 * view for the server's statistics and spans tenants.
 */
export interface EmbeddingStore {
  /** The text to embed and the Markdown hash it belongs to, for a live page of the tenant with Markdown (a page that is gone, in the trash, or has no Markdown has none). */
  pageText(tenantId: string, pageId: string): Promise<{ readonly markdownHash: Uint8Array; readonly text: string } | undefined>;
  /** The content hash of each chunk of the page that is stored for `model`, by chunk index. */
  existingHashes(tenantId: string, pageId: string, model: string): Promise<Map<number, Uint8Array>>;
  /**
   * Stores `chunks` as the page's chunks (every other chunk of the page is removed, whatever its model: a page has one set and one state, `model` is a column) and marks the page `ready` for `model` at `markdownHash`, in one
   * transaction that first checks the page's Markdown hash is still `markdownHash`: when it is not, the page changed while it was embedded, nothing is written and the answer is `stale`.
   * A chunk without an `embedding` keeps the vector stored at its index; it must be there with the same hash, or the call throws and writes nothing.
   */
  replacePage(tenantId: string, pageId: string, markdownHash: Uint8Array, model: string, chunks: readonly ChunkRow[]): Promise<'ok' | 'stale'>;
  /** Marks the page `failed` at `markdownHash` for `model` with a reason code (never text) and counts the attempt. A page that changed since (`markdownHash` is not current) is left alone. */
  markFailed(tenantId: string, pageId: string, markdownHash: Uint8Array, model: string, error: string): Promise<void>;
  /**
   * Pages with Markdown, not deleted, last edited more than `olderThanSeconds` ago, that have no state for `model` at their current hash: new pages, edited pages and pages
   * of another model. and pages that failed fewer than `EMBED_MAX_ATTEMPTS` times at their current hash and model. Oldest edit first, at most `limit`.
   */
  pagesNeedingEmbedding(tenantId: string, model: string, o: { readonly olderThanSeconds: number; readonly limit: number }): Promise<readonly { readonly pageId: string; readonly markdownHash: Uint8Array }[]>;
  /**
   * The chunks nearest to `queryVector`, best first, of the pages the person may read: the collections are applied inside the query (R9.8), pages in the trash are left out, and
   * chunks under `minSimilarity` are not returned.
   */
  search(
    tenantId: string,
    queryVector: Float32Array,
    o: { readonly model: string; readonly collectionIds: readonly string[]; readonly collectionId?: string; readonly limit: number; readonly minSimilarity: number },
  ): Promise<readonly ChunkHit[]>;
  /** What exists for `model`, over every tenant. */
  counts(model: string): Promise<{ readonly chunks: number; readonly pagesReady: number; readonly pagesFailed: number; readonly pagesPending: number }>;
}
