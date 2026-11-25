import { createPageAccess } from '@tektum/grimoire-core/authorize';
import { createAuthorizer } from '@tektum/grimoire-core/authorize/authorizer';
import type { AuthVerifier } from '@tektum/grimoire-core/ports/auth-verifier';
import type { UserRecord } from '@tektum/grimoire-core/ports/user-store';
import { createFakeAccessStore, emptyWorld } from '@tektum/grimoire-core/testing/fake-access-store';
import { FakeCollectionRepo } from '@tektum/grimoire-core/testing/fake-collection-repo';
import { FakeIdempotencyStore } from '@tektum/grimoire-core/testing/fake-idempotency-store';
import { FakeSearchRepo } from '@tektum/grimoire-core/testing/fake-search-repo';
import { FakeUserStore } from '@tektum/grimoire-core/testing/fake-user-store';
import { createProvisioner } from '@tektum/grimoire-core/users/provisioner';
import { createApp } from '../../src/app.js';
import { makeContext } from '../server/support/context.js';

import type { SemanticSearch } from '@tektum/grimoire-core/search/hybrid-search';

export const PAGE = (n: number) => `00000000-0000-4000-8000-0000000007${String(n).padStart(2, '0')}`;

/** Two people in one tenant: `member` reads `Open` and `Shared`; `closed` is a collection only administrators read. */
export function build(openPermission: 'read' | null = 'read', semantic?: SemanticSearch) {
  const t = makeContext();
  const world = emptyWorld();
  const verifier: AuthVerifier = { verify: (token) => Promise.resolve({ kind: 'ok', userId: `d-${token}`, expiresAt: 9e12 }) };
  const rows: UserRecord[] = [
    ['member', 'member'],
    ['admin', 'admin'],
  ].map(([name, role], i) => ({
    id: `00000000-0000-4000-8000-00000000060${String(i)}`,
    descopeUserId: `d-${name}`,
    email: `${name}@example.com`,
    name: name as string,
    role: role as 'member' | 'admin',
    suspended: false,
    tenantId: 'legacy',
  }));
  for (const r of rows) world.users.push({ id: r.id, role: r.role, suspended: false });
  const users = new FakeUserStore(rows);
  const signInPolicy = { firstAdminEmails: [], allowedEmailDomains: ['example.com'], refusedEmailDomains: [], allowDevRole: false };
  const collections = new FakeCollectionRepo(world);
  const open = collections.seed({ name: 'Open', description: null, icon: null, color: null, position: 'a1', defaultPermission: openPermission });
  const closed = collections.seed({ name: 'Closed', description: null, icon: null, color: null, position: 'a2', defaultPermission: null });
  const search = new FakeSearchRepo();
  const hit = (n: number, collectionId: string, over: object = {}) =>
    search.seed({
      tenantId: 'legacy',
      pageId: PAGE(n),
      urlId: `u${String(n)}`,
      title: `Page ${String(n)}`,
      collectionId,
      snippet: { text: 'a match here', ranges: [[2, 7]] },
      partial: false,
      updatedAt: 1_700_000_000_000,
      rank: 0.5,
      ...over,
    });
  const store = createFakeAccessStore(world);
  const app = createApp({
    ...t.ctx,
    auth: { verifier },
    signInPolicy,
    http: {
      ...t.ctx.http,
      users,
      collections,
      search,
      ...(semantic === undefined ? {} : { hybrid: semantic }),
      idempotency: new FakeIdempotencyStore(t.clock),
      provisioner: createProvisioner({ users, verifier, policy: signInPolicy }),
      access: createPageAccess(store),
      authorizer: createAuthorizer(store),
    },
  });
  const call = (who: string | undefined, query: string) => app.request(`/v1/search${query}`, { headers: who === undefined ? {} : { authorization: `Bearer ${who}` } });
  return { call, search, hit, open: open.id, closed: closed.id, logger: t.logger, clock: t.clock };
}
