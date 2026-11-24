import type { SeededContent } from '../pages/seeded-content.js';

/** What a page answers with outside its content (R6.22 to R6.26). Times are epoch milliseconds. */
export interface PageMeta {
  readonly id: string;
  readonly urlId: string;
  readonly collectionId: string;
  readonly parentId: string | null;
  readonly position: string;
  readonly title: string;
  readonly icon: string | null;
  readonly createdBy: string;
  readonly lastEditedBy: string | null;
  readonly lastEditedAt: number | null;
  readonly savedAt: number;
  readonly stateEpoch: number;
}

/** A page for `GET /v1/pages/{id}` (R6.23): no content. `breadcrumb` is the ancestors, root first, without the page itself. */
export interface PageDetail extends PageMeta {
  readonly breadcrumb: readonly { readonly id: string; readonly title: string }[];
  /** When the saved Markdown fell behind the editor state, epoch milliseconds; null when it is current. */
  readonly markdownStaleSince: number | null;
  /** The saved Markdown is behind the editor state: a stale time is recorded, or the page has state and no Markdown at all (then the time is null). */
  readonly markdownStale: boolean;
}

/** What `markdownOf` returns: the stored Markdown with the facts that go with it, from one row. */
export interface MarkdownOfPage {
  readonly markdown: string | null;
  readonly hasState: boolean;
  readonly title: string;
  readonly savedAt: number;
  readonly markdownStaleSince: number | null;
}

/** A change of a page's title and icon (R6.24). */
export interface PageMetaPatch {
  readonly title?: string | undefined;
  readonly icon?: string | null | undefined;
}

/** Limits a create enforces under the collection's lock. */
export interface PageLimits {
  /** Deepest level of the page tree (a top-level page is level 1). */
  readonly maxDepth: number;
  /** Most live pages in one collection. */
  readonly maxPages: number;
}

export interface NewPage {
  readonly collectionId: string;
  readonly parentId: string | null;
  /** Place the page after this sibling (same parent); null for last. */
  readonly afterId: string | null;
  readonly title: string;
  readonly createdBy: string;
  /** The Markdown with its editor state; only `seedUserMarkdown` makes one. Absent: a page with no Markdown and no state. */
  readonly content?: SeededContent | undefined;
}

export type CreatePageResult =
  | { readonly kind: 'created'; readonly page: PageMeta }
  /** The collection is not there or was deleted since the caller was checked. */
  | { readonly kind: 'collection-deleted' }
  | { readonly kind: 'no-parent' }
  | { readonly kind: 'no-after' }
  | { readonly kind: 'too-deep' }
  | { readonly kind: 'collection-full' };

/** Where a page goes (R6.25). `collectionId` null: it stays in its collection. `afterId` null: last among the new siblings. */
export interface PageMove {
  /** The collection the caller's access check was made against. If the page is elsewhere by the time the move runs, nothing moves (`conflict`). */
  readonly expectedCollectionId: string;
  readonly collectionId: string | null;
  readonly parentId: string | null;
  readonly afterId: string | null;
}

export type MovePageResult =
  | { readonly kind: 'moved'; readonly page: PageMeta }
  /** The page is not live (or its collection is deleted). */
  | { readonly kind: 'not-found' }
  | { readonly kind: 'collection-deleted' }
  | { readonly kind: 'no-parent' }
  | { readonly kind: 'no-after' }
  | { readonly kind: 'would-create-cycle' }
  | { readonly kind: 'too-deep' }
  | { readonly kind: 'collection-full' }
  /** The page changed collection after the caller was checked, or concurrent changes kept the transaction from committing after its retries. */
  | { readonly kind: 'conflict' };

export type SoftDeleteResult =
  | { readonly kind: 'deleted'; readonly pages: number }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'conflict' };

/** Pages and the page tree. */
export interface PageRepo {
  /**
   * Adds a page in one transaction: the collection row is locked first (so a delete of the collection and other creates run one at a
   * time), then the collection must still be live, the parent and `afterId` must be live in it, the depth and the page count are
   * checked, and the row is inserted in ONE statement together with its Markdown and state. `position` gets the keys of the
   * neighbours (null for an open end) and returns the new key.
   */
  create(input: NewPage, limits: PageLimits, position: (before: string | null, after: string | null) => string): Promise<CreatePageResult>;
  /** A live page of a live collection with its breadcrumb, or undefined. */
  get(id: string): Promise<PageDetail | undefined>;
  /**
   * What the Markdown export serves, read from one row in one statement (so the body and its times belong together): the saved Markdown
   * (null when none was ever saved), whether the row has an editor state, the title, `savedAt` and `markdownStaleSince` (epoch
   * milliseconds, as in `PageDetail`), for a live page of a live collection; undefined otherwise. Never converts anything.
   */
  markdownOf(id: string): Promise<MarkdownOfPage | undefined>;
  /** The id of the page with this URL id, deleted or not (the caller decides access from the id), or undefined. */
  idOfUrlId(urlId: string): Promise<string | undefined>;
  /**
   * Changes the title and icon of a live page. A title change recomputes the stored Markdown hash from the stored Markdown in the same
   * transaction, so an editor save with identical content that follows is a skip (R4.21). Undefined when the page is not live.
   */
  updateMeta(id: string, patch: PageMetaPatch): Promise<PageMeta | undefined>;
  /**
   * Moves a live page with its whole subtree (deleted descendants too, so every parent link stays inside one collection) in one
   * serializable transaction, retried at most three times when the database aborts it. The collection rows involved are locked first,
   * in id order. Refuses a target under the page itself or one of its descendants, the level after the deepest (the whole moved subtree
   * counts), and a target collection the subtree would take above `maxPages`.
   */
  move(id: string, to: PageMove, limits: PageLimits, position: (before: string | null, after: string | null) => string): Promise<MovePageResult>;
  /**
   * Soft-deletes a live page and every live descendant in one transaction, all with `deleted_batch` = the page's own id; no row is
   * removed. Descendants deleted earlier keep their own batch. The collection row is locked first, as create and move do, and the page
   * must still be in `expectedCollectionId`, the collection the caller's access check was made against: a page that moved since is not
   * deleted on that check (`conflict`).
   */
  softDelete(id: string, deletedBy: string, expectedCollectionId: string): Promise<SoftDeleteResult>;
}
