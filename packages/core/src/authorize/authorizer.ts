import type { AccessFacts, AccessOptions, AccessRequest, AccessStore, CollectionAccessRequest } from '../ports/access-store.js';
import { decide, decideCollection } from './decide.js';
import type { AccessDecision, CollectionDecision } from './decide.js';

export interface Authorizer {
  check(r: AccessRequest, opts?: AccessOptions): Promise<AccessDecision>;
  checkMany(rs: readonly AccessRequest[]): Promise<readonly AccessDecision[]>;
  checkCollection(r: CollectionAccessRequest, opts?: AccessOptions): Promise<CollectionDecision>;
  visibleCollections(userId: string, opts?: AccessOptions): Promise<readonly { collectionId: string; access: 'read-write' | 'read-only' }[]>;
}

/**
 * Facts from the store, the decision from `decide`. A store that rejects makes the call reject (no decision is ever invented), and a store that
 * answers with fewer facts than requests gets the missing ones decided as facts-less, that is denied.
 */
export function createAuthorizer(store: AccessStore): Authorizer {
  const pageFacts = async (rs: readonly AccessRequest[]): Promise<readonly AccessFacts[]> => {
    const facts = await store.facts(rs);
    // Facts that answer another request than the one asked are treated as no facts (a store bug must deny, never grant).
    return rs.map((request, i) => {
      const f = facts[i];
      return f !== undefined && f.request.userId === request.userId && f.request.pageId === request.pageId ? f : { request };
    });
  };
  return {
    async check(r, opts) {
      const [f] = await pageFacts([r]);
      return decide(f ?? { request: r }, opts);
    },
    async checkMany(rs) {
      return (await pageFacts(rs)).map((f) => decide(f));
    },
    async checkCollection(r, opts) {
      const [f] = await store.collectionFacts([r]);
      const own = f !== undefined && f.request.userId === r.userId && f.request.collectionId === r.collectionId;
      return decideCollection(own ? f : { request: r }, opts);
    },
    async visibleCollections(userId, opts) {
      const rows = await store.visibleCollections(userId, opts);
      return rows.filter((row) => row.access === 'read-write' || row.access === 'read-only');
    },
  };
}
