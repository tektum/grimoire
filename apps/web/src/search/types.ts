/** One result of `GET /v1/search` (R6.34; M7-contracts section 2 and 15.5). Nothing here is markup: every text is plain text. */
export interface SearchSnippet {
  readonly text: string;
  /** `[start, end)` offsets in UTF-16 code units of `text`, the words that matched. */
  readonly ranges: readonly (readonly [number, number])[];
}

export interface SearchItem {
  readonly pageId: string;
  readonly urlId: string;
  readonly title: string;
  readonly snippet: SearchSnippet;
  /** The plain text of the passage that matched by meaning, for a result the semantic list found. */
  readonly matchedPassage?: { readonly text: string };
  /** True when only the beginning of the page is searchable. */
  readonly partial?: boolean;
  readonly collectionId: string;
  readonly rank: number;
  readonly updatedAt: string;
}

export interface SearchPage {
  readonly items: readonly SearchItem[];
  /** False when search fell back to full text (R9.30). */
  readonly semantic?: boolean;
  readonly nextCursor: string | null;
}

/** The longest query the API takes (R6.34: 1 to 200 characters). */
export const QUERY_MAX = 200;
