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

/** A listed revision with the exact sort position the next page starts after: whole microseconds since the epoch, however fine the stored time is. */
export interface ListedRevision extends RevisionSummary {
  readonly sortKey: number;
}

export interface RevisionListQuery {
  /** At most this many, newest first. */
  readonly limit: number;
  /** The `[sortKey, id]` of the last row of the previous page. */
  readonly after?: readonly [number, string] | undefined;
}

/** What the host's rules ask of the repository when a page's saved state should become a revision (R9.2). */
export interface PageRevisionRequest {
  readonly pageId: string;
  readonly reason: 'idle' | 'last_editor_left' | 'before_restore';
  /** Everyone who changed the page since the previous revision, user ids; ids that are not users are ignored. */
  readonly authorIds: readonly string[];
  readonly lastAuthorId: string | null;
  /** The time of the last edit, epoch milliseconds: the revision is dated then, not when it is written. */
  readonly at: number;
}

export type PageRevisionResult =
  | { readonly kind: 'created'; readonly id: string }
  /** The title and Markdown equal the latest revision's. */
  | { readonly kind: 'unchanged' }
  /** The saved Markdown is older than the editor state (`markdown_stale_since` is set): a revision would date old text at the last edit. */
  | { readonly kind: 'stale' }
  /** The page has no saved Markdown yet. */
  | { readonly kind: 'no-markdown' }
  | { readonly kind: 'no-page' };

export type BeforeRestoreResult =
  /** A revision of the last saved state was written. */
  | { readonly kind: 'created'; readonly id: string }
  /** The last saved state equals the latest revision: that one is the safety copy. */
  | { readonly kind: 'existing'; readonly id: string }
  /** The saved Markdown is older than the editor state: a copy now would miss the newest edits. */
  | { readonly kind: 'stale' }
  /** The page has no saved Markdown yet: there is nothing to copy. */
  | { readonly kind: 'nothing-saved' }
  | { readonly kind: 'no-page' };

/** A revision made by the catch-up after a restart. */
export interface CaughtUpRevision {
  readonly pageId: string;
  readonly revisionId: string;
}

/** The history of pages. The runtime role can insert and read revisions, never change or remove one (R9.5). */
export interface RevisionRepo {
  /** The revisions of a page, newest first (ties by id), after the cursor. */
  list(pageId: string, query: RevisionListQuery): Promise<readonly ListedRevision[]>;
  /** One revision of this page with its Markdown, or undefined. */
  get(pageId: string, revisionId: string): Promise<Revision | undefined>;
  /**
   * Makes a revision of the page's saved state, reading the page in the same transaction: skipped when the stored title and Markdown
   * equal the latest revision, and refused while the saved Markdown is stale.
   */
  createFromPage(request: PageRevisionRequest): Promise<PageRevisionResult>;
  /**
   * The revisions a restart lost (R9.3): for pages whose last edit is older than `editedBefore` (epoch milliseconds), that are not stale and
   * whose title and Markdown differ from the latest revision (or that have none), one revision with reason `idle`, dated at the last edit
   * and naming the last editor. At most `limit` pages per call; returns what it created.
   */
  catchUp(editedBefore: number, limit: number): Promise<readonly CaughtUpRevision[]>;
  /**
   * The safety copy before a restore (R9.2, R9.6): a revision with reason `before_restore` of the page's last saved state, dated at its
   * last edit and naming its last editor, in one transaction with the read. Identical to the latest revision: that one is returned and
   * nothing is written. Refused while the saved Markdown is stale.
   */
  snapshotBeforeRestore(pageId: string): Promise<BeforeRestoreResult>;
}
