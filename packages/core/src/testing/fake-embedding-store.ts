import type { ChunkHit, ChunkRow, EmbeddingStore } from '../ports/embedding-store.js';

interface PageFact { readonly tenantId: string; readonly collectionId: string; markdownHash: Uint8Array | null; editedAt: number; deleted: boolean }
interface StateRow { markdownHash: Uint8Array; status: 'ready' | 'failed'; attempts: number; error: string | null }

const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * In-memory EmbeddingStore for tests, with the same filters as the SQL: a tenant, the readable collections, pages in the trash left out, a floor on the similarity.
 * The pages are facts of the test's world (`seedPage`, `editPage`, `trashPage`); the store keeps only chunks and states, as the tables do.
 */
export class FakeEmbeddingStore implements EmbeddingStore {
  private readonly pages = new Map<string, PageFact>();
  private readonly chunks = new Map<string, Map<string, ChunkRow[]>>(); // page id -> model -> chunks
  private readonly states = new Map<string, Map<string, StateRow>>(); // page id -> model -> state

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
  stored(pageId: string, model: string): { readonly chunks: readonly ChunkRow[]; readonly state: Readonly<StateRow> | undefined } {
    return { chunks: this.chunks.get(pageId)?.get(model) ?? [], state: this.states.get(pageId)?.get(model) };
  }

  private page(tenantId: string, pageId: string): PageFact | undefined {
    const page = this.pages.get(pageId);
    return page?.tenantId === tenantId ? page : undefined;
  }

  existingHashes(tenantId: string, pageId: string, model: string): Promise<Map<number, Uint8Array>> {
    const rows = this.page(tenantId, pageId) === undefined ? [] : (this.chunks.get(pageId)?.get(model) ?? []);
    return Promise.resolve(new Map(rows.map((c) => [c.chunkIndex, c.contentHash])));
  }

  replacePage(tenantId: string, pageId: string, markdownHash: Uint8Array, model: string, chunks: readonly ChunkRow[]): Promise<'ok' | 'stale'> {
    const page = this.page(tenantId, pageId);
    if (page === undefined || page.markdownHash === null || !same(page.markdownHash, markdownHash)) return Promise.resolve('stale');
    this.byModel(this.chunks, pageId).set(model, [...chunks].sort((a, b) => a.chunkIndex - b.chunkIndex));
    this.byModel(this.states, pageId).set(model, { markdownHash, status: 'ready', attempts: 0, error: null });
    return Promise.resolve('ok');
  }

  markFailed(tenantId: string, pageId: string, markdownHash: Uint8Array, model: string, error: string): Promise<void> {
    const page = this.page(tenantId, pageId);
    if (page?.markdownHash == null || !same(page.markdownHash, markdownHash)) return Promise.resolve();
    const states = this.byModel(this.states, pageId);
    const before = states.get(model);
    states.set(model, { markdownHash, status: 'failed', attempts: (before !== undefined && same(before.markdownHash, markdownHash) ? before.attempts : 0) + 1, error });
    return Promise.resolve();
  }

  pagesNeedingEmbedding(tenantId: string, model: string, o: { readonly olderThanSeconds: number; readonly limit: number }): Promise<readonly { readonly pageId: string; readonly markdownHash: Uint8Array }[]> {
    const cutoff = this.now() - o.olderThanSeconds * 1000;
    const due = [...this.pages]
      .filter(([, p]) => p.tenantId === tenantId && !p.deleted && p.markdownHash !== null && p.editedAt < cutoff)
      .filter(([id, p]) => {
        const state = this.states.get(id)?.get(model);
        return state === undefined || !same(state.markdownHash, p.markdownHash as Uint8Array);
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
    for (const [pageId, byModel] of this.chunks) {
      const page = this.page(tenantId, pageId);
      if (page === undefined || page.deleted || !o.collectionIds.includes(page.collectionId) || (o.collectionId !== undefined && page.collectionId !== o.collectionId)) continue;
      for (const c of byModel.get(o.model) ?? []) {
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
      chunks += this.chunks.get(id)?.get(model)?.length ?? 0;
      if (page.deleted || page.markdownHash === null) continue;
      const state = this.states.get(id)?.get(model);
      if (state === undefined || !same(state.markdownHash, page.markdownHash)) pagesPending += 1;
      else if (state.status === 'ready') pagesReady += 1;
      else pagesFailed += 1;
    }
    return Promise.resolve({ chunks, pagesReady, pagesFailed, pagesPending });
  }

  private byModel<T>(map: Map<string, Map<string, T>>, pageId: string): Map<string, T> {
    let m = map.get(pageId);
    if (m === undefined) map.set(pageId, (m = new Map()));
    return m;
  }
}
