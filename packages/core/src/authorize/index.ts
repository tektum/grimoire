import type { AccessFacts, AccessOptions, AccessRequest, AccessStore } from '../ports/access-store.js';
import { decide } from './decide.js';

/**
 * The collapsed form of the authorisation rule (R6.4, contracts section 2): the answer every caller outside tests uses.
 * `decide` keeps its distinct deny reasons for tests and logs; here every `none` (no-page, deleted, no-access, and a user that
 * vanished or was suspended since it was resolved) becomes the same `not-found`, so a caller cannot tell a missing page from a
 * forbidden one. Readable-but-not-writable is the one case told apart: `allowed` at `read-only` (a route answers 403 for a write).
 *
 * Timing: every answer costs exactly one `store.facts` round trip and then the pure `decide`; there is no early return before the
 * database is consulted, and the denial branches differ only in in-memory comparisons.
 */
export type PageAccess =
  | { readonly result: 'allowed'; readonly access: 'read-write' | 'read-only'; readonly epoch: number }
  | { readonly result: 'not-found' };

export interface PageAccessChecker {
  checkAccess(r: AccessRequest, opts?: AccessOptions): Promise<'allowed' | 'not-found'>;
  checkAccessMany(rs: readonly AccessRequest[], opts?: AccessOptions): Promise<readonly ('allowed' | 'not-found')[]>;
  /** The same answer with the level and epoch, for callers that open a session at that level (the collaboration host). */
  pageAccess(r: AccessRequest, opts?: AccessOptions): Promise<PageAccess>;
  /** One database round trip for all requests, same order (the session re-check). */
  pageAccessMany(rs: readonly AccessRequest[], opts?: AccessOptions): Promise<readonly PageAccess[]>;
}

const NOT_FOUND: PageAccess = Object.freeze({ result: 'not-found' });

/** Facts that answer another request than the one asked are treated as no facts (a store bug must deny, never grant). */
const factsFor = (r: AccessRequest, f: AccessFacts | undefined): AccessFacts =>
  f !== undefined && f.request.userId === r.userId && f.request.pageId === r.pageId ? f : { request: r };

function collapse(r: AccessRequest, f: AccessFacts | undefined, opts?: AccessOptions): PageAccess {
  const d = decide(factsFor(r, f), opts);
  if (d.access === 'read-write' || d.access === 'read-only') return { result: 'allowed', access: d.access, epoch: d.epoch };
  return NOT_FOUND; // every `none`, and anything the decision does not literally allow
}

export function createPageAccess(store: AccessStore): PageAccessChecker {
  const many = async (rs: readonly AccessRequest[], opts?: AccessOptions): Promise<readonly PageAccess[]> => {
    if (rs.length === 0) return [];
    const facts = await store.facts(rs);
    return rs.map((r, i) => collapse(r, facts[i], opts));
  };
  const one = async (r: AccessRequest, opts?: AccessOptions): Promise<PageAccess> => (await many([r], opts))[0] ?? NOT_FOUND;
  return {
    pageAccess: one,
    pageAccessMany: many,
    checkAccess: async (r, opts) => (await one(r, opts)).result,
    checkAccessMany: async (rs, opts) => (await many(rs, opts)).map((a) => a.result),
  };
}
