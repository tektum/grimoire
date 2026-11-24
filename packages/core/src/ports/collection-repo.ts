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

export type PrincipalType = 'user' | 'group';

export interface AccessEntry {
  readonly id: string;
  readonly principalType: PrincipalType;
  readonly principalId: string;
  /** The user's or the group's name. */
  readonly name: string;
  readonly permission: StoredPermission;
}

export interface AccessList { readonly defaultPermission: StoredPermission | null; readonly entries: readonly AccessEntry[] }

export interface AccessGrant { readonly principalType: PrincipalType; readonly principalId: string; readonly permission: StoredPermission }

export type UpsertAccessResult =
  | { readonly kind: 'saved'; readonly entry: AccessEntry }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'no-principal' };

/** One live page of a collection, as the flat tree sends it. */
export interface TreePage {
  readonly id: string;
  readonly urlId: string;
  readonly parentId: string | null;
  readonly position: string;
  readonly title: string;
  readonly icon: string | null;
}

/**
 * Collections and their access entries. Every change that can take access away also writes its audit row in the same transaction. Every method works inside one tenant
 * (docs/tenancy.md section 3.3): a collection of another tenant is absent, and an entry can name only a person or a group of the collection's own tenant (`no-principal`).
 */
export interface CollectionRepo {
  /** The live collections among `ids`, in `position` order. */
  listLive(tenantId: string, ids: readonly string[]): Promise<readonly CollectionRecord[]>;
  /** A live collection, or undefined. */
  get(tenantId: string, id: string): Promise<CollectionRecord | undefined>;
  /**
   * Adds a collection after the last live one. `positionAfter` gets that last position (null when there is none) and returns the new
   * one; the read and the insert are one step, so two creates never choose the same position.
   */
  append(tenantId: string, input: NewCollection, positionAfter: (last: string | null) => string): Promise<CollectionRecord>;
  /** Applies the patch to a live collection. A change of `defaultPermission` writes the audit row `collection.default_permission_changed`. */
  update(tenantId: string, id: string, patch: CollectionPatch, actorId: string): Promise<UpdateResult>;
  /** The default permission and the entries of a live collection (oldest entry first), or undefined. */
  listAccess(tenantId: string, collectionId: string): Promise<AccessList | undefined>;
  /** Inserts the entry, or changes the permission of the principal's existing one (the id stays). Writes the audit row `collection.access_upserted`. */
  upsertAccess(tenantId: string, collectionId: string, grant: AccessGrant, actorId: string): Promise<UpsertAccessResult>;
  /** Removes an entry of this collection. Writes the audit row `collection.access_removed`. False when the collection has no such entry. */
  removeAccess(tenantId: string, collectionId: string, entryId: string, actorId: string): Promise<boolean>;
  /** The live pages of a live collection, flat, in `position` order; undefined when the collection is not live. */
  tree(tenantId: string, collectionId: string): Promise<readonly TreePage[] | undefined>;
  /**
   * Soft-deletes a live collection and every live page in it as one batch: one fresh batch id on all of them, no row removed. Pages that
   * were already deleted keep their own batch. Writes the audit row `collection.deleted`. Undefined when the collection is not live.
   */
  softDelete(tenantId: string, collectionId: string, actorId: string): Promise<{ readonly batch: string; readonly pages: number } | undefined>;
}
