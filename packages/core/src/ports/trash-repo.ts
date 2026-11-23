import type { PageLimits, PageMeta } from './page-repo.js';

/** The root of a deleted batch, as the trash list shows it. `deletedAt` is epoch milliseconds. */
export interface TrashRoot {
  readonly id: string;
  readonly title: string;
  readonly collectionId: string;
  readonly deletedAt: number;
  readonly deletedBy: string | null;
}

/** The sort values of the last root of a page of the list: newest first, ties by id. */
export interface TrashCursor {
  readonly deletedAt: number;
  readonly id: string;
}

/** What the trash routes need to decide about a root page before they act on its batch. */
export interface TrashRootInfo {
  readonly id: string;
  readonly collectionId: string;
  /** The `deleted_batch` of the page (its own id for a page delete, one shared id for a collection delete). */
  readonly batch: string;
  readonly collectionDeleted: boolean;
}

export type RestoreResult =
  | { readonly kind: 'restored'; readonly page: PageMeta }
  /** Not a root of a deleted batch (any more). */
  | { readonly kind: 'not-found' }
  | { readonly kind: 'collection-deleted' }
  | { readonly kind: 'collection-full' };

/** Deleted pages: the batches the trash lists, restores and purges. The only place that removes page rows. */
export interface TrashRepo {
  /**
   * Roots of deleted batches, newest first: a root is a deleted page whose parent is none or is not in its batch. `collectionIds` null
   * is every collection. Fetch `limit` rows (the caller asks for one more than a page to know whether there is a next one).
   */
  roots(collectionIds: readonly string[] | null, limit: number, after?: TrashCursor): Promise<readonly TrashRoot[]>;
  /** The root page `id` of a deleted batch, or undefined when it is not one. */
  rootOf(id: string): Promise<TrashRootInfo | undefined>;
  /**
   * Restores the whole batch of the root page `id` in one transaction under the collection's lock. A root whose parent is gone or
   * deleted returns at the top level, before the first live top-level sibling; otherwise it keeps its parent and its place (last
   * among the siblings when a live page took the place). Refused when the collection is deleted, or when the live pages and the
   * batch together would pass `maxPages`.
   */
  restore(id: string, limits: PageLimits, position: (before: string | null, after: string | null) => string): Promise<RestoreResult>;
  /** The object keys of the attachments of every page of the batch. */
  attachmentKeys(batch: string): Promise<readonly string[]>;
  /**
   * Deletes every page row of the batch in one statement (revisions and attachment rows go with them) and writes the audit row
   * `page.purged`, ids only, in the same transaction. A batch already gone deletes nothing and writes no row (`pages: 0`).
   */
  purge(batch: string, actorId: string): Promise<{ readonly pages: number }>;
}
