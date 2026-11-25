import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createCollabHost } from '@tektum/grimoire-adapter-collab-hocuspocus';
import { FakeAuthVerifier } from '@tektum/grimoire-adapter-auth-fake';
import { createJsonLogger } from '@tektum/grimoire-adapter-logger-json';
import { createPageAccess } from '@tektum/grimoire-core/authorize';
import type { PageAccessChecker } from '@tektum/grimoire-core/authorize';
import type { PageStore } from '@tektum/grimoire-core/ports/collaboration-host';
import { accessCases, worldOfCases } from '@tektum/grimoire-core/testing/access-cases';
import { createFakeAccessStore } from '@tektum/grimoire-core/testing/fake-access-store';
import { FakeClock } from '@tektum/grimoire-core/testing/fake-clock';
import { makeFakeConfig } from '@tektum/grimoire-core/testing/fake-config';
import { FakeRevisionRepo } from '@tektum/grimoire-core/testing/fake-revision-repo';
import { FakeLogger } from '@tektum/grimoire-core/testing/fake-logger';
import { FakeMarkdownConverter } from '@tektum/grimoire-core/testing/fake-markdown-converter';
import { FakeUserStore } from '@tektum/grimoire-core/testing/fake-user-store';
import { connect, eventually } from '@tektum/grimoire-test-support';
import type { Client } from '@tektum/grimoire-test-support';
import { compose } from '../../src/composition.js';
import { createEventLog } from '../../src/events.js';
import { createRun } from '../../src/lifecycle/run.js';
import { EXIT } from '../../src/lifecycle/process.js';
import { placeholderDatabaseUrl } from '@tektum/grimoire-core/testing/database-url';

// Security review F7: the authorisation stub cannot ship. The stub exists only in this test file.
/** TEST ONLY: answers "allowed, read-write" for every page, the shape of the earlier authorisation stub. */
function createStubAuthorizer(): PageAccessChecker {
  return {
    checkAccess: () => Promise.resolve('allowed'),
    checkAccessMany: (rs) => Promise.resolve(rs.map(() => 'allowed' as const)),
    pageAccess: () => Promise.resolve({ result: 'allowed', access: 'read-write', epoch: 0 }),
    pageAccessMany: (rs) => Promise.resolve(rs.map(() => ({ result: 'allowed' as const, access: 'read-write' as const, epoch: 0 }))),
  };
}

const nonLocal = {
  GRIMOIRE_DATABASE_URL: placeholderDatabaseUrl('127.0.0.1:1'), GRIMOIRE_DATABASE_OPS_URL: placeholderDatabaseUrl('127.0.0.1:1'), GRIMOIRE_ALLOWED_ORIGINS: 'http://127.0.0.1:8080',
  GRIMOIRE_DESCOPE_PROJECT_ID: 'P2abc', GRIMOIRE_ALLOWED_EMAIL_DOMAINS: 'example.test',
};

describe('the authorisation stub cannot ship', () => {
  it('no source file outside tests mentions a stub authoriser', () => {
    let out = '';
    try {
      out = execFileSync('grep', ['-rln', 'authorize/stub\\|createStubAuthorizer', 'apps/server/src', 'packages', '--include=*.ts', '--exclude-dir=node_modules', '--exclude-dir=dist'], { encoding: 'utf8' });
    } catch (e) {
      if (!(typeof e === 'object' && e !== null && 'status' in e && e.status === 1)) throw e; // grep exits 1 when nothing matches
    }
    const hits = out.split('\n').filter(Boolean);
    expect(hits.filter((f) => !/\/test\//.test(f))).toEqual([]);
  });

  it('a composition with a test stub and GRIMOIRE_LOCAL unset refuses to start: server.start_failed naming authorizer-stub, no listener', async () => {
    const lines: string[] = [];
    const log = createEventLog(createJsonLogger({ destination: { write: (l) => lines.push(l) } }));
    const c = compose(nonLocal, { access: createStubAuthorizer() });
    expect(c.ok).toBe(false);
    if (c.ok) return;
    let code: number | undefined;
    await createRun({ compose: () => ({ ...c, log }), exit: (n) => { code = n; } })();
    expect(code).toBe(EXIT.failure);
    const events = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events).toEqual([expect.objectContaining({ event: 'server.start_failed', errorCode: 'authorizer-stub' })]);
    expect(lines.join('')).not.toContain('http.listening');
  });

  it('the same stub in local mode composes (tests may use it there)', async () => {
    const c = compose({ ...nonLocal, GRIMOIRE_DESCOPE_PROJECT_ID: '', GRIMOIRE_ALLOWED_EMAIL_DOMAINS: '', GRIMOIRE_LOCAL: '1', GRIMOIRE_DEV_TOKEN_SECRET: 'test-secret-0123456789abcdef' }, { access: createStubAuthorizer() });
    expect(c.ok).toBe(true);
    if (c.ok) for (const h of c.ctx.shutdownHooks) await h.run();
  });
});

describe('a user with access only to collection X cannot open a page of collection Y', () => {
  const clients: Client[] = [];
  const stops: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) c.destroy();
    for (const s of stops.splice(0)) await s();
  });

  it('own collection: admitted at the table level; every other collection without a default permission: not-found', async () => {
    const { world, ids } = worldOfCases(accessCases);
    const clock = new FakeClock(1_000_000);
    const verifier = new FakeAuthVerifier(clock);
    const users = new FakeUserStore(world.users.map((u) => ({ id: u.id, descopeUserId: `sub-${u.id}`, email: `${u.id}@example.test`, name: 'n', role: u.role, suspended: u.suspended, tenantId: 'legacy' })));
    for (const u of world.users) verifier.allow(`tok-${u.id}`, `sub-${u.id}`);
    const pages: PageStore = {
      load: () => Promise.resolve({ state: null, markdown: null, markdownHash: null, epoch: 0, markdownStaleSince: null }),
      seed: () => Promise.resolve({ state: null, seeded: false, epoch: 0 }),
      store: () => Promise.resolve({ written: true }),
      listStale: () => Promise.resolve([]),
      repairMarkdown: () => Promise.resolve('skipped'),
    };
    const host = createCollabHost();
    await host.start({
      // Many refusals from one address are the point of this test: the attempt limit is raised so it never bans the test client.
      config: makeFakeConfig({ collab: { connectAttemptsPerWindow: 1_000_000 } }), logger: new FakeLogger(), clock, verifier, pages,
      converter: new FakeMarkdownConverter({ convert: () => ({ ok: true, markdown: '', text: '' }) }),
      resolveUser: (_token, identity) => users.findByDescopeId(identity.userId),
      access: createPageAccess(createFakeAccessStore(world)), revisions: new FakeRevisionRepo(),
    });
    const server = createServer();
    server.on('upgrade', (req, socket, head) => { host.handleUpgrade(req, socket, head); });
    await new Promise<void>((r) => { server.listen(0, '127.0.0.1', r); });
    stops.push(async () => { await host.shutdown({ deadlineMs: 500 }); server.closeAllConnections(); await new Promise<void>((r) => { server.close(() => { r(); }); }); });
    const url = `ws://127.0.0.1:${String((server.address() as AddressInfo).port)}/collab`;

    // Users with an own entry on their own collection only (members and viewers, not suspended); foreign pages live, no default permission.
    const holders = accessCases.flatMap((c, i) => (c.ownEntry && !c.suspended && (c.role === 'member' || c.role === 'viewer') && c.page === 'live' && c.collection === 'live' && c.groupEntries.length === 0 && c.defaultPermission === null ? [i] : []));
    const foreign = accessCases.flatMap((c, i) => (c.page === 'live' && c.collection === 'live' && c.defaultPermission === null ? [i] : []));
    expect(holders.length).toBeGreaterThanOrEqual(4);
    const outcome = async (token: string, page: string): Promise<string> => {
      const c = connect(url, page, token, { maxAttempts: 1 }); clients.push(c);
      await eventually(() => c.provider.isAuthenticated || c.failures.length > 0, 5000, 'answered');
      const r = c.failures[0] ?? (c.provider.authorizedScope ?? 'none');
      c.destroy();
      return r;
    };
    for (const i of holders) {
      const own = ids[i];
      const kase = accessCases[i];
      if (own === undefined || kase === undefined) throw new Error('table');
      expect(await outcome(`tok-${own.userId}`, own.pageId), kase.name).toBe(kase.expect === 'read-write' ? 'read-write' : 'readonly');
      for (const j of foreign) {
        const other = ids[j];
        if (j === i || other === undefined) continue;
        expect(await outcome(`tok-${own.userId}`, other.pageId), `${kase.name} -> page of case ${String(j)}`).toBe('not-found');
      }
    }
  }, 60_000);
});
