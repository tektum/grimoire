import type { Role } from './user-store.js';

export type Permission = 'read' | 'read_write';
export interface AccessRequest { readonly userId: string; readonly pageId: string }   // userId = users.id
export interface AccessFacts {
  readonly request: AccessRequest;
  readonly user?: { readonly role: Role; readonly suspended: boolean };
  readonly page?: { readonly deleted: boolean; readonly epoch: number;
    readonly collection: { readonly deleted: boolean; readonly defaultPermission: Permission | null; readonly entries: readonly Permission[] } };  // entries: the user's own entry plus the entries of the user's groups
}
export interface CollectionAccessRequest { readonly userId: string; readonly collectionId: string }
export interface CollectionFacts { readonly request: CollectionAccessRequest; readonly user?: { readonly role: Role; readonly suspended: boolean };
  readonly collection?: { readonly deleted: boolean; readonly defaultPermission: Permission | null; readonly entries: readonly Permission[] } }
export interface AccessOptions { readonly includeDeleted?: boolean } // trash routes (HTTP routes, planned): deleted pages and collections still decide
export interface AccessStore {
  facts(requests: readonly AccessRequest[]): Promise<readonly AccessFacts[]>;                       // ONE database round trip for all requests, same order, rejects if the database is unreachable
  collectionFacts(requests: readonly CollectionAccessRequest[]): Promise<readonly CollectionFacts[]>; // same contract, for collection routes (HTTP routes, planned)
  visibleCollections(userId: string, opts?: AccessOptions): Promise<readonly { collectionId: string; access: 'read-write' | 'read-only' }[]>; // set-valued SQL form of decideCollection (R8.15)
}
