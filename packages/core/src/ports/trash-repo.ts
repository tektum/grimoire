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
  | { readonly kind: 'collection-full' }
  /** The page is in another collection than the one the caller's access was checked against (it moved since): nothing is restored. */
  | { readonly kind: 'conflict' };

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
   * Restores the whole batch of the root page `id` in one transaction under the collection's lock, only if the page is still in
   * `expectedCollectionId`, the collection the caller's access check was made against (else `conflict`). A root whose parent is gone
   * or deleted, or under which the batch would be deeper than `maxDepth`, returns at the top level, before the first live top-level
   * sibling; otherwise (a live parent, or no parent) it keeps its place, or goes last among the siblings when a live page took the
   * place. Refused when the collection is deleted, or when the live pages and the batch together would pass `maxPages`.
   */
  restore(id: string, expectedCollectionId: string, limits: PageLimits, position: (before: string | null, after: string | null) => string): Promise<RestoreResult>;
  /**
   * The object keys of the attachments of every page the purge of the batch removes: the batch and any page below it that was deleted
   * earlier, in a batch of its own (a page cannot be removed while a child still points at it).
   */
  attachmentKeys(batch: string): Promise<readonly string[]>;
  /**
   * Deletes every page row of the batch, and the pages below it deleted earlier, in one statement (revisions and attachment rows go with
   * them) and writes the audit row `page.purged`, ids only, in the same transaction. A batch already gone deletes nothing and writes no
   * row (`pages: 0`). `removedKeys` are the objects the caller has already removed: an attachment row of a page that a restore brought
   * back in the meantime is marked deleted, so no live page keeps a row whose object is gone.
   */
  purge(batch: string, actorId: string, removedKeys: readonly string[]): Promise<{ readonly pages: number }>;
}
