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

/** Pages and the page tree. */
export interface PageRepo {
  /**
   * Adds a page in one transaction: the collection row is locked first (so a delete of the collection and other creates run one at a
   * time), then the collection must still be live, the parent and `afterId` must be live in it, the depth and the page count are
   * checked, and the row is inserted in ONE statement together with its Markdown and state. `position` gets the keys of the
   * neighbours (null for an open end) and returns the new key.
   */
  create(input: NewPage, limits: PageLimits, position: (before: string | null, after: string | null) => string): Promise<CreatePageResult>;
}
