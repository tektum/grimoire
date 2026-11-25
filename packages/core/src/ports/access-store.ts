import type { Role } from './user-store.js';

export type Permission = 'read' | 'read_write';
// userId = users.id; tenantId = the tenant of the person asking, from the token or the signed-in row, never from the page: the facts are read in that tenant (docs/tenancy.md section 3.2)
export interface AccessRequest { readonly tenantId: string; readonly userId: string; readonly pageId: string }
export interface AccessFacts {
  readonly request: AccessRequest;
  readonly user?: { readonly role: Role; readonly suspended: boolean; /** The user row's `tenant_id` (docs/tenancy.md). A store that knows nothing of tenants leaves it out, on both rows. */ readonly tenantId?: string };
  readonly page?: { readonly deleted: boolean; readonly epoch: number; /** The page row's `tenant_id`; must equal the user's, or the page is not there for that person. */ readonly tenantId?: string;
    readonly collection: { readonly deleted: boolean; readonly defaultPermission: Permission | null; readonly entries: readonly Permission[] } };  // entries: the user's own entry plus the entries of the user's groups
}
export interface CollectionAccessRequest { readonly tenantId: string; readonly userId: string; readonly collectionId: string }
export interface CollectionFacts { readonly request: CollectionAccessRequest; readonly user?: { readonly role: Role; readonly suspended: boolean; /** As in `AccessFacts`: the user row's `tenant_id`, or absent on both. */ readonly tenantId?: string };
  readonly collection?: { readonly deleted: boolean; /** The collection row's `tenant_id`; must equal the user's. */ readonly tenantId?: string; readonly defaultPermission: Permission | null; readonly entries: readonly Permission[] } }
export interface AccessOptions { readonly includeDeleted?: boolean } // trash routes (HTTP routes, planned): deleted pages and collections still decide
export interface AccessStore {
  facts(requests: readonly AccessRequest[]): Promise<readonly AccessFacts[]>;                       // ONE statement for all requests of a tenant, same order, rejects if the database is unreachable
  collectionFacts(requests: readonly CollectionAccessRequest[]): Promise<readonly CollectionFacts[]>; // same contract, for collection routes (HTTP routes, planned)
  visibleCollections(tenantId: string, userId: string, opts?: AccessOptions): Promise<readonly { collectionId: string; access: 'read-write' | 'read-only' }[]>; // set-valued SQL form of decideCollection (R8.15)
}
