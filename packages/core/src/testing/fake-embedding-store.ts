import { EMBED_MAX_ATTEMPTS, type ChunkHit, type ChunkRow, type EmbeddingStore } from '../ports/embedding-store.js';

/** A chunk as stored: the embedding is always there. */
type StoredChunk = ChunkRow & { readonly embedding: Float32Array };
interface PageFact { readonly tenantId: string; readonly collectionId: string; markdownHash: Uint8Array | null; editedAt: number; deleted: boolean }
interface StateRow { model: string; markdownHash: Uint8Array; status: 'ready' | 'failed'; attempts: number; error: string | null }

const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * In-memory EmbeddingStore for tests, with the same filters as the SQL: a tenant, the readable collections, pages in the trash left out, a floor on the similarity.
 * The pages are facts of the test's world (`seedPage`, `editPage`, `trashPage`); the store keeps only chunks and states, as the tables do.
 */
export class FakeEmbeddingStore implements EmbeddingStore {
  private readonly pages = new Map<string, PageFact>();
  // One set of chunks and one state per page, as the tables' keys (page_id; page_id, chunk_index) allow: `model` is a column, so a write for another model replaces them.
  private readonly chunks = new Map<string, { model: string; rows: StoredChunk[] }>();
  private readonly states = new Map<string, StateRow>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  seedPage(page: { readonly id: string; readonly collectionId: string; readonly markdownHash: Uint8Array | null; readonly tenantId?: string; readonly editedAt?: number }): void {
    this.pages.set(page.id, { tenantId: page.tenantId ?? 'legacy', collectionId: page.collectionId, markdownHash: page.markdownHash, editedAt: page.editedAt ?? 0, deleted: false });
  }

  /** The page's Markdown changed (as a save does): its hash and edit time. */
  editPage(id: string, markdownHash: Uint8Array, editedAt: number): void {
    const page = this.pages.get(id);
    if (page !== undefined) Object.assign(page, { markdownHash, editedAt });
  }

  trashPage(id: string): void {
    const page = this.pages.get(id);
    if (page !== undefined) page.deleted = true;
  }

  /** What is stored for a page and model, for assertions. */
  stored(pageId: string, model: string): { readonly chunks: readonly StoredChunk[]; readonly state: Readonly<StateRow> | undefined } {
    const state = this.states.get(pageId);
    return { chunks: this.rowsOf(pageId, model), state: state?.model === model ? state : undefined };
  }

  private page(tenantId: string, pageId: string): PageFact | undefined {
    const page = this.pages.get(pageId);
    return page?.tenantId === tenantId ? page : undefined;
  }

  existingHashes(tenantId: string, pageId: string, model: string): Promise<Map<number, Uint8Array>> {
    const rows = this.page(tenantId, pageId) === undefined ? [] : this.rowsOf(pageId, model);
    return Promise.resolve(new Map(rows.map((c) => [c.chunkIndex, c.contentHash])));
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- async so that a throw is a rejection, as the real store's is
  async replacePage(tenantId: string, pageId: string, markdownHash: Uint8Array, model: string, chunks: readonly ChunkRow[]): Promise<'ok' | 'stale'> {
    const page = this.page(tenantId, pageId);
    if (page === undefined || page.markdownHash === null || !same(page.markdownHash, markdownHash)) return 'stale';
    const before = this.chunks.get(pageId);
    const kept = new Map((before?.model === model ? before.rows : []).map((c) => [c.chunkIndex, c]));
    const rows = chunks.map((c): StoredChunk => {
      if (c.embedding !== undefined) return { ...c, embedding: c.embedding };
      const old = kept.get(c.chunkIndex);
      if (old === undefined || !same(old.contentHash, c.contentHash)) throw new Error(`no stored vector to keep for chunk ${String(c.chunkIndex)}`);
      return { ...c, embedding: old.embedding };
    });
    this.chunks.set(pageId, { model, rows: rows.sort((a, b) => a.chunkIndex - b.chunkIndex) });
    this.states.set(pageId, { model, markdownHash, status: 'ready', attempts: 0, error: null });
    return 'ok';
  }

  markFailed(tenantId: string, pageId: string, markdownHash: Uint8Array, model: string, error: string): Promise<void> {
    const page = this.page(tenantId, pageId);
    if (page?.markdownHash == null || !same(page.markdownHash, markdownHash)) return Promise.resolve();
    const before = this.states.get(pageId);
    this.states.set(pageId, { model, markdownHash, status: 'failed', attempts: (before?.model === model && same(before.markdownHash, markdownHash) ? before.attempts : 0) + 1, error });
    return Promise.resolve();
  }

  pagesNeedingEmbedding(tenantId: string, model: string, o: { readonly olderThanSeconds: number; readonly limit: number }): Promise<readonly { readonly pageId: string; readonly markdownHash: Uint8Array }[]> {
    const cutoff = this.now() - o.olderThanSeconds * 1000;
    const due = [...this.pages]
      .filter(([, p]) => p.tenantId === tenantId && !p.deleted && p.markdownHash !== null && p.editedAt < cutoff)
      .filter(([id, p]) => {
        const state = this.states.get(id);
        return state?.model !== model || !same(state.markdownHash, p.markdownHash as Uint8Array) || (state.status === 'failed' && state.attempts < EMBED_MAX_ATTEMPTS);
      })
      .sort((a, b) => a[1].editedAt - b[1].editedAt || (a[0] < b[0] ? -1 : 1));
    return Promise.resolve(due.slice(0, o.limit).map(([pageId, p]) => ({ pageId, markdownHash: p.markdownHash as Uint8Array })));
  }

  search(
    tenantId: string,
    queryVector: Float32Array,
    o: { readonly model: string; readonly collectionIds: readonly string[]; readonly collectionId?: string; readonly limit: number; readonly minSimilarity: number },
  ): Promise<readonly ChunkHit[]> {
    const hits: ChunkHit[] = [];
    for (const pageId of this.chunks.keys()) {
      const page = this.page(tenantId, pageId);
      if (page === undefined || page.deleted || !o.collectionIds.includes(page.collectionId) || (o.collectionId !== undefined && page.collectionId !== o.collectionId)) continue;
      for (const c of this.rowsOf(pageId, o.model)) {
        if (c.embedding.length !== queryVector.length) continue; // another dimension is another model's
        const similarity = c.embedding.reduce((sum, x, i) => sum + x * (queryVector[i] as number), 0);
        if (similarity >= o.minSimilarity) hits.push({ pageId, chunkIndex: c.chunkIndex, charStart: c.charStart, charEnd: c.charEnd, similarity });
      }
    }
    return Promise.resolve(hits.sort((a, b) => b.similarity - a.similarity || (a.pageId < b.pageId ? -1 : a.pageId > b.pageId ? 1 : a.chunkIndex - b.chunkIndex)).slice(0, o.limit));
  }

  counts(model: string): Promise<{ readonly chunks: number; readonly pagesReady: number; readonly pagesFailed: number; readonly pagesPending: number }> {
    let chunks = 0;
    let pagesReady = 0;
    let pagesFailed = 0;
    let pagesPending = 0;
    for (const [id, page] of this.pages) {
      chunks += this.rowsOf(id, model).length;
      if (page.deleted || page.markdownHash === null) continue;
      const state = this.states.get(id);
      if (state?.model !== model || !same(state.markdownHash, page.markdownHash)) pagesPending += 1;
      else if (state.status === 'ready') pagesReady += 1;
      else pagesFailed += 1;
    }
    return Promise.resolve({ chunks, pagesReady, pagesFailed, pagesPending });
  }

  private rowsOf(pageId: string, model: string): readonly StoredChunk[] {
    const c = this.chunks.get(pageId);
    return c?.model === model ? c.rows : [];
  }
}
