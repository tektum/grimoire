import type { Snippet } from '../search/snippet.js';

/**
 * One search (docs/search.md). The tenant comes from the caller's verified identity: a search never crosses tenants. The caller decides what the person may read and
 * passes it as `collectionIds`; the repository applies it inside the query, so ranking, the limit and the cursor only ever see pages the person may open.
 */
export interface SearchRequest {
  readonly tenantId: string;
  /** The collections the person may read (deleted ones are not in it). */
  readonly collectionIds: readonly string[];
  /** Trimmed, 1 to 200 characters. */
  readonly query: string;
  readonly limit: number;
  /** What the previous page returned. A cursor this repository did not issue throws `InvalidSearchCursor`. */
  readonly cursor?: string;
  /** Only this collection; one the person cannot read is no match, not an error. */
  readonly collectionId?: string;
}

export interface SearchHit {
  readonly pageId: string;
  readonly urlId: string;
  readonly title: string;
  readonly collectionId: string;
  /** Plain text and the offsets of the matches; holds no markup. */
  readonly snippet: Snippet;
  /** True when only the beginning of the page is indexed (its body is beyond what a tsvector holds). */
  readonly partial: boolean;
  /** Epoch milliseconds of the last edit. */
  readonly updatedAt: number;
  readonly rank: number;
}

export interface SearchPage {
  readonly hits: readonly SearchHit[];
  /** Absent on the last page. There is no total: it would say how many pages the person cannot see. */
  readonly nextCursor?: string;
}

/** The statement ran past its timeout (`GRIMOIRE_SEARCH_STATEMENT_TIMEOUT_MS`) and was cancelled. */
export class SearchTimeoutError extends Error {
  constructor() {
    super('the search ran past its time limit');
    this.name = 'SearchTimeoutError';
  }
}

/** Full-text search over the pages a person may read. The query runs in one transaction with its own statement timeout. */
export interface SearchRepo {
  search(request: SearchRequest): Promise<SearchPage>;
}
