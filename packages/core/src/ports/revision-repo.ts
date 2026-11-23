export type RevisionReason = 'idle' | 'last_editor_left' | 'before_restore' | 'manual' | 'import';

/** A person as a revision shows them. */
export interface RevisionAuthor {
  readonly id: string;
  readonly name: string;
}

/** A revision without its text (R6.31). `createdAt` is epoch milliseconds: the time of the last edit it records. */
export interface RevisionSummary {
  readonly id: string;
  readonly createdAt: number;
  readonly title: string;
  readonly lastAuthor: RevisionAuthor | null;
  readonly authors: readonly RevisionAuthor[];
  readonly reason: RevisionReason;
}

/** A revision with its Markdown (R6.32). */
export interface Revision extends RevisionSummary {
  readonly markdown: string;
}

export interface RevisionListQuery {
  /** At most this many, newest first. */
  readonly limit: number;
  /** The `[createdAt, id]` of the last row of the previous page. */
  readonly after?: readonly [number, string] | undefined;
}

/** The history of pages. The runtime role can insert and read revisions, never change or remove one (R9.5). */
export interface RevisionRepo {
  /** The revisions of a page, newest first (ties by id), after the cursor. */
  list(pageId: string, query: RevisionListQuery): Promise<readonly RevisionSummary[]>;
  /** One revision of this page with its Markdown, or undefined. */
  get(pageId: string, revisionId: string): Promise<Revision | undefined>;
}
