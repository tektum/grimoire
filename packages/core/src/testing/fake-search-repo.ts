import type { SearchHit, SearchPage, SearchRepo, SearchRequest } from '../ports/search-repo.js';

/** In-memory search for tests: the pages seeded for the request's tenant and readable collections, in the order seeded; it does not rank or match the query. */
export class FakeSearchRepo implements SearchRepo {
  readonly requests: SearchRequest[] = [];
  private readonly rows: (SearchHit & { readonly tenantId: string })[] = [];
  /** Test setup: the next `search` rejects with this. */
  failNext: Error | undefined;

  seed(row: SearchHit & { readonly tenantId: string }): void {
    this.rows.push(row);
  }

  search(request: SearchRequest): Promise<SearchPage> {
    this.requests.push(request);
    if (this.failNext !== undefined) {
      const error = this.failNext;
      this.failNext = undefined;
      return Promise.reject(error);
    }
    const hits = this.rows
      .filter((r) => r.tenantId === request.tenantId && request.collectionIds.includes(r.collectionId) && (request.collectionId === undefined || r.collectionId === request.collectionId))
      .slice(0, request.limit)
      .map((r) => ({ pageId: r.pageId, urlId: r.urlId, title: r.title, collectionId: r.collectionId, snippet: r.snippet, partial: r.partial, updatedAt: r.updatedAt, rank: r.rank }));
    return Promise.resolve({ hits });
  }
}
