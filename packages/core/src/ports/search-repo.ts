/** One search (docs: M7 contracts section 2). The tenant comes from the caller's verified identity: a search never crosses tenants. */
export interface SearchRequest {
  readonly tenantId: string;
  readonly userId: string;
  readonly query: string;
  readonly limit: number;
  /** Opaque: what the previous page returned. */
  readonly cursor?: string;
  readonly collectionId?: string;
}

export interface SearchHit {
  readonly pageId: string;
  readonly urlId: string;
  readonly title: string;
  readonly collectionId: string;
  /** The part of the body that matched, or null when only the title did. */
  readonly snippet: string | null;
  readonly editedAt: number;
  readonly rank: number;
}

export interface SearchPage {
  readonly hits: readonly SearchHit[];
  readonly nextCursor?: string;
}

/** Full-text search over the pages a user may read. The query runs in one transaction with its own statement timeout. */
export interface SearchRepo {
  search(request: SearchRequest): Promise<SearchPage>;
}
