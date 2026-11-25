import type { SearchHit, SearchPage, SearchRepo, SearchRequest } from '../ports/search-repo.js';

/** In-memory search for tests: the pages seeded for the request's tenant, in the order seeded; it does not rank or match the query. */
export class FakeSearchRepo implements SearchRepo {
  readonly requests: SearchRequest[] = [];
  private readonly rows: (SearchHit & { readonly tenantId: string })[] = [];

  seed(row: SearchHit & { readonly tenantId: string }): void {
    this.rows.push(row);
  }

  search(request: SearchRequest): Promise<SearchPage> {
    this.requests.push(request);
    const hits = this.rows.filter((r) => r.tenantId === request.tenantId).slice(0, request.limit).map((row) => ({ pageId: row.pageId, urlId: row.urlId, title: row.title, collectionId: row.collectionId, snippet: row.snippet, editedAt: row.editedAt, rank: row.rank }));
    return Promise.resolve({ hits });
  }
}
