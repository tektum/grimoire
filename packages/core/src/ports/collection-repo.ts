/** Spelling of a permission as stored and as the API sends `defaultPermission` and entries. The authoriser answers `read-write` or `read-only`. */
export type StoredPermission = 'read' | 'read_write';

export interface CollectionRecord {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly icon: string | null;
  readonly color: string | null;
  readonly position: string;
  readonly defaultPermission: StoredPermission | null;
}

export interface NewCollection {
  readonly name: string;
  readonly description?: string | undefined;
  readonly icon?: string | undefined;
  readonly color?: string | undefined;
  readonly defaultPermission?: StoredPermission | undefined;
  readonly createdBy: string;
}

export interface CollectionPatch {
  readonly name?: string | undefined;
  readonly description?: string | null | undefined;
  readonly icon?: string | null | undefined;
  readonly color?: string | null | undefined;
  readonly defaultPermission?: StoredPermission | null | undefined;
  readonly position?: string | undefined;
}

export type UpdateResult =
  | { readonly kind: 'updated'; readonly collection: CollectionRecord }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'position-taken' };

/** Collections and their access entries. Every change that can take access away also writes its audit row in the same transaction. */
export interface CollectionRepo {
  /** The live collections among `ids`, in `position` order. */
  listLive(ids: readonly string[]): Promise<readonly CollectionRecord[]>;
  /** A live collection, or undefined. */
  get(id: string): Promise<CollectionRecord | undefined>;
  /**
   * Adds a collection after the last live one. `positionAfter` gets that last position (null when there is none) and returns the new
   * one; the read and the insert are one step, so two creates never choose the same position.
   */
  append(input: NewCollection, positionAfter: (last: string | null) => string): Promise<CollectionRecord>;
  /** Applies the patch to a live collection. A change of `defaultPermission` writes the audit row `collection.default_permission_changed`. */
  update(id: string, patch: CollectionPatch, actorId: string): Promise<UpdateResult>;
}
