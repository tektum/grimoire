import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { createDescopeVerifier } from '@tektum/grimoire-adapter-auth-descope';
import type { DescopeVerifier } from '@tektum/grimoire-adapter-auth-descope';
import { createCollabHost, RECHECK_DATABASE_TIMEOUT_MS } from '@tektum/grimoire-adapter-collab-hocuspocus';
import type { HocuspocusCollabHost } from '@tektum/grimoire-adapter-collab-hocuspocus';
import { createAccessStore, createDatabase, createPageStore, createUserStore } from '@tektum/grimoire-adapter-db-kysely';
import type { KyselyDatabase } from '@tektum/grimoire-adapter-db-kysely';
import { createPageAccess } from '@tektum/grimoire-core/authorize';
import type { AccessStore } from '@tektum/grimoire-core/ports/access-store';
import { makeFakeConfig } from '@tektum/grimoire-core/testing/fake-config';
import { FakeLogger } from '@tektum/grimoire-core/testing/fake-logger';
import { FakeMarkdownConverter } from '@tektum/grimoire-core/testing/fake-markdown-converter';
import { ALLOWED_ORIGIN, originSocket } from '@tektum/grimoire-test-support';
import { appUrl, createTestDatabase, dropTestDatabase, requireBuild, sqlAdmin } from '../server/support/harness.js';
import { createIssuer, KeyService, PROJECT_ID } from '../server/support/descope-double.js';
import type { Issuer } from '../server/support/descope-double.js';
import { connect, DEV_COLLECTION, devFixtures, eventually, StallProxy } from './support.js';
import type { Client } from './support.js';

// on the production wiring outside local mode: the Descope verifier against a local key-service double,
// the real database, the real access store and host, with GRIMOIRE_COLLAB_RECHECK_SECONDS at its smallest (1). Real time passes: a
// token that lives 4 seconds really expires. The clock is the system clock, as in composition.ts.
const DB = 'grimoire_t07_recheck';
const RECHECK_INTERVAL_SECONDS = 1;
const SLACK_MS = 30_000;
const CLOSED = '00000000-0000-4000-8000-0000000000da';
const SYSTEM = '00000000-0000-4000-8000-000000000001';
let issuer: Issuer;
const clients: { destroy(): void }[] = [];
const stops: (() => Promise<void>)[] = [];

interface Rig {
  readonly url: string;
  readonly logger: FakeLogger;
  readonly host: HocuspocusCollabHost;
  readonly db: KyselyDatabase;
  /** Calls of `facts` on the real access store and the size of each batch. */
  readonly facts: number[];
}
async function rig(o: { dbUrl?: string; collab?: Record<string, number> } = {}): Promise<Rig> {
  const keys = new KeyService(issuer); await keys.start();
  const logger = new FakeLogger();
  const clock = { now: () => Date.now() };
  const verifier: DescopeVerifier = createDescopeVerifier({ projectId: PROJECT_ID, baseUrl: keys.baseUrl, logger, clock, maxTokenLifetimeMs: 3_600_000 });
  const db = createDatabase(o.dbUrl ?? appUrl(DB), { maxConnections: 4, queryTimeoutMs: 1500, connectionTimeoutMs: 1500 });
  const users = createUserStore(db);
  const real = createAccessStore(db);
  const facts: number[] = [];
  const store: AccessStore = { ...real, facts: (rs) => { facts.push(rs.length); return real.facts(rs); } };
  const host = createCollabHost();
  await host.start({
    config: makeFakeConfig({ collab: { recheckSeconds: RECHECK_INTERVAL_SECONDS, connectAttemptsPerWindow: 10_000, ...o.collab } }), logger, clock, verifier,
    resolveUser: (_t, identity) => users.findByDescopeId(identity.userId),
    access: createPageAccess(store), pages: createPageStore(db, clock),
    converter: new FakeMarkdownConverter({ convert: () => ({ ok: true, markdown: '', text: '' }) }),
  });
  const server: Server = createServer();
  server.on('upgrade', (req, socket, head) => { host.handleUpgrade(req, socket, head); });
  await new Promise<void>((r) => { server.listen(0, '127.0.0.1', r); });
  stops.push(async () => {
    await host.shutdown({ deadlineMs: 500 }); server.closeAllConnections();
    await new Promise<void>((r) => { server.close(() => { r(); }); });
    verifier.close(); await db.close(); await keys.stop();
  });
  return { url: `ws://127.0.0.1:${String((server.address() as AddressInfo).port)}/collab`, logger, host, db, facts };
}

interface Open { readonly client: Client; readonly reasons: string[] }
const open = (r: Rig, page: string, token: string | (() => string)): Open => {
  const client = connect(r.url, page, token, { maxAttempts: 1 });
  clients.push(client);
  const reasons: string[] = [];
  client.provider.on('close', ({ event }: { event: { reason: string } }) => { reasons.push(event.reason); });
  return { client, reasons };
};
const authed = (c: Open): Promise<true> => eventually(() => c.client.provider.isAuthenticated, 8000, 'authenticated');
const closedBy = (c: Open): Promise<string> => eventually(() => c.reasons[0], 8000, 'closed by the re-check');
async function user(sub: string, role = 'member'): Promise<string> {
  const id = randomUUID();
  await sqlAdmin(DB, `insert into users (id, descope_user_id, email, name, role) values ('${id}', '${sub}', '${sub.toLowerCase()}@example.test', '${sub}', '${role}')`);
  return id;
}
async function page(collection = DEV_COLLECTION): Promise<string> {
  const id = randomUUID();
  await sqlAdmin(DB, `insert into pages (id, collection_id) values ('${id}', '${collection}')`);
  return id;
}
const grant = (collection: string, userId: string, permission: 'read' | 'read_write'): Promise<unknown[]> =>
  sqlAdmin(DB, `insert into collection_access (collection_id, user_id, permission) values ('${collection}', '${userId}', '${permission}')`);
const nowSec = (): number => Math.floor(Date.now() / 1000);
const serverText = (r: Rig, id: string): string => r.host.hocuspocus?.documents.get(id)?.getText('prosemirror').toString() ?? '';

beforeAll(async () => {
  requireBuild();
  await createTestDatabase(DB, true);
  await devFixtures(DB);
  await sqlAdmin(DB, `insert into collections (id, name, position, created_by) values ('${CLOSED}', 'Closed', 'b0', '${SYSTEM}')`);
  issuer = await createIssuer();
}, 60_000);
afterEach(async () => {
  clients.splice(0).forEach((c) => { c.destroy(); });
  for (const s of stops.splice(0)) await s();
});
afterAll(async () => { await dropTestDatabase(DB); });

// One failed round takes up to the interval plus the re-check's database limit; slack for a loaded runner under coverage.
const ROUND_BUDGET_MS = RECHECK_INTERVAL_SECONDS * 1000 + RECHECK_DATABASE_TIMEOUT_MS + SLACK_MS;

describe('re-check on the real server and database (1 s interval)', () => {
  it('a user suspended while connected is closed within the interval; a neighbour on the same page is not', async () => {
    const r = await rig();
    await user('T7victim'); await user('T7neighbour');
    const p = await page();
    const victim = open(r, p, await issuer.token('T7victim'));
    const neighbour = open(r, p, await issuer.token('T7neighbour'));
    await authed(victim); await authed(neighbour);
    await sqlAdmin(DB, "update users set suspended_at = now() where descope_user_id = 'T7victim'");
    expect(await closedBy(victim)).toBe('access-changed');
    expect(neighbour.client.provider.isAuthenticated).toBe(true);
    expect(neighbour.reasons).toEqual([]);
    expect(r.logger.entries.filter((e) => e.event === 'collab.access_closed').map((e) => e.fields)).toEqual([{ pageId: p, reason: 'no-access' }]);
  }, 30_000);

  it('access removed from the collection closes the connection access-changed; the reconnect is refused not-found', async () => {
    const r = await rig();
    const id = await user('T7removed');
    const p = await page(CLOSED);
    await grant(CLOSED, id, 'read_write');
    const token = await issuer.token('T7removed');
    const c = open(r, p, token);
    await authed(c);
    await sqlAdmin(DB, `delete from collection_access where collection_id = '${CLOSED}' and user_id = '${id}'`);
    expect(await closedBy(c)).toBe('access-changed');
    const again = open(r, p, token);
    await eventually(() => again.client.failures.length > 0, 8000, 'reconnect refused');
    expect(again.client.failures).toEqual(['not-found']);
  }, 30_000);

  it('lowered to read: closed access-changed; edits sent through the whole sequence never land; the reconnect is read-only', async () => {
    const r = await rig();
    const id = await user('T7lowered'); await user('T7writer');
    const p = await page(CLOSED);
    await grant(CLOSED, id, 'read_write');
    await sqlAdmin(DB, `insert into collection_access (collection_id, user_id, permission) select '${CLOSED}', id, 'read_write' from users where descope_user_id = 'T7writer'`);
    const token = await issuer.token('T7lowered');
    const lowered = open(r, p, token);
    const writer = open(r, p, await issuer.token('T7writer'));
    await authed(lowered); await authed(writer);
    lowered.client.text.insert(0, 'before;');
    await eventually(() => serverText(r, p).includes('before;'), 8000, 'a write lands while writable');
    await sqlAdmin(DB, `update collection_access set permission = 'read' where collection_id = '${CLOSED}' and user_id = '${id}'`);
    await eventually(() => { lowered.client.text.insert(lowered.client.text.length, 'x;'); return lowered.reasons.length > 0; }, 8000, 'closed by the re-check');
    expect(lowered.reasons).toEqual(['access-changed']);
    for (let i = 0; i < 20; i++) lowered.client.text.insert(lowered.client.text.length, `late${String(i)};`);
    const again = open(r, p, token);
    await authed(again);
    expect(again.client.provider.authorizedScope).toBe('readonly');
    again.client.text.insert(0, 'ro-edit;');
    writer.client.text.insert(0, 'W-marker;');
    await eventually(() => again.client.text.toString().includes('W-marker;'), 8000, 'reading continues');
    expect(serverText(r, p)).not.toContain('late');
    expect(serverText(r, p)).not.toContain('ro-edit');
  }, 30_000);

  it('a trashed page closes the connection with access-changed', async () => {
    const r = await rig();
    await user('T7trash');
    const p = await page();
    const c = open(r, p, await issuer.token('T7trash'));
    await authed(c);
    await sqlAdmin(DB, `update pages set deleted_at = now() where id = '${p}'`);
    expect(await closedBy(c)).toBe('access-changed');
  }, 30_000);

  it('a bumped state_epoch closes the connection with access-changed', async () => {
    const r = await rig();
    await user('T7epoch');
    const p = await page();
    const c = open(r, p, await issuer.token('T7epoch'));
    await authed(c);
    await sqlAdmin(DB, `update pages set state_epoch = state_epoch + 1 where id = '${p}'`);
    expect(await closedBy(c)).toBe('access-changed');
  }, 30_000);

  it('a session that expires without a fresh token is closed session-expired, at expiry or within one interval after', async () => {
    const r = await rig();
    await user('T7expires'); await user('T7steady');
    const p = await page();
    const exp = nowSec() + 4; // one reading: the token and the expected closing time must use the same second
    const expiring = open(r, p, await issuer.token('T7expires', { exp, iat: exp - 9 }));
    const steady = open(r, p, await issuer.token('T7steady'));
    await authed(expiring); await authed(steady);
    const expiresAtMs = exp * 1000;
    expect(await closedBy(expiring)).toBe('session-expired');
    expect(Date.now() - expiresAtMs).toBeLessThan(2500); // one interval of 1 s plus the scheduling of the tick and of the test
    expect(Date.now()).toBeGreaterThanOrEqual(expiresAtMs);
    expect(steady.client.provider.isAuthenticated).toBe(true);
  }, 30_000);

  it('a session renewed on the open connection (a fresh token for the same user) is kept past its first expiry', async () => {
    const r = await rig();
    await user('T7renew');
    const p = await page();
    let current = await issuer.token('T7renew', { exp: nowSec() + 4, iat: nowSec() - 5 });
    const fresh = await issuer.token('T7renew');
    const c = open(r, p, () => current);
    await authed(c);
    current = fresh; // the provider answers the server's token request with this
    const firstExpiry = (nowSec() + 4) * 1000;
    await eventually(() => Date.now() > firstExpiry + 2500, 10_000, 'past the first expiry and one more interval');
    expect(c.client.provider.isAuthenticated).toBe(true);
    expect(c.reasons).toEqual([]);
  }, 30_000);

  it('a fresh token for ANOTHER USER is refused: the connection is closed and keeps its own identity until then', async () => {
    const r = await rig();
    const victimId = await user('T7mine'); await user('T7theirs');
    const p = await page();
    let current = await issuer.token('T7mine', { exp: nowSec() + 6, iat: nowSec() - 5 });
    const theirs = await issuer.token('T7theirs');
    const c = open(r, p, () => current);
    await authed(c);
    const owner = (): unknown => [...(r.host.hocuspocus?.documents.get(p)?.getConnections() ?? [])].map((x) => (x.context as { userId?: string }).userId);
    expect(owner()).toEqual([victimId]);
    current = theirs;
    expect(await closedBy(c)).toBe('invalid-token');
    expect(r.logger.entries.filter((e) => e.event === 'collab.token_sync_failed').map((e) => e.fields)).toEqual([{ pageId: p, reason: 'user-mismatch' }]);
    expect(JSON.stringify(r.logger.entries)).not.toContain(theirs);
  }, 30_000);

  it('a refresh token, an expired token and a token of another project presented on an open connection each close it 4401 invalid-token', async () => {
    const r = await rig();
    await user('T7bad');
    const p = await page();
    const cases = [
      await issuer.token('T7bad', { drn: 'DSR' }),
      await issuer.token('T7bad', { exp: nowSec() - 60, iat: nowSec() - 120 }),
      await issuer.token('T7bad', { iss: 'someone-else' }),
    ];
    for (const bad of cases) {
      let current = await issuer.token('T7bad', { exp: nowSec() + 6, iat: nowSec() - 5 });
      const c = open(r, p, () => current);
      await authed(c);
      current = bad;
      expect(await closedBy(c)).toBe('invalid-token');
    }
  }, 60_000);

  it('the database down for two intervals closes nobody with a valid session; when it is back the checks resume', async () => {
    const proxy = await StallProxy.start(); stops.push(() => proxy.stop());
    const r = await rig({ dbUrl: proxy.url(DB) });
    await user('T7outage');
    const p = await page();
    const c = open(r, p, await issuer.token('T7outage'));
    await authed(c);
    proxy.stall();
    const failures = (): number => r.logger.entries.filter((e) => e.event === 'collab.recheck_skipped').length;
    await eventually(() => failures() >= 1, ROUND_BUDGET_MS, 'a round failed');
    const callsDuringOutage = r.facts.length;
    await eventually(() => r.facts.length >= callsDuringOutage + 2, 2 * ROUND_BUDGET_MS, 'two more rounds tried');
    expect(c.reasons).toEqual([]);
    expect(c.client.provider.isAuthenticated).toBe(true);
    proxy.release();
    await sqlAdmin(DB, "update users set suspended_at = now() where descope_user_id = 'T7outage'");
    expect(await closedBy(c)).toBe('access-changed');
  }, 3 * ROUND_BUDGET_MS + 30_000);

  it('300 open documents: a round costs a small bounded number of queries, not one per connection', async () => {
    const r = await rig({ collab: { maxOpenDocuments: 400, maxDocumentsPerUser: 400, maxSocketsPerUser: 400, maxConnections: 400, maxConnectionsPerPage: 400 } });
    await user('T7many');
    const token = await issuer.token('T7many');
    const ids = Array.from({ length: 300 }, () => randomUUID());
    await sqlAdmin(DB, `insert into pages (id, collection_id) select unnest(array[${ids.map((i) => `'${i}'::uuid`).join(',')}]), '${DEV_COLLECTION}'`);
    const providers: HocuspocusProvider[] = [];
    for (let s = 0; s < 6; s++) {
      const shared = new HocuspocusProviderWebsocket({ url: r.url, WebSocketPolyfill: originSocket(ALLOWED_ORIGIN) });
      clients.push({ destroy: () => { shared.destroy(); } });
      for (const id of ids.slice(s * 50, (s + 1) * 50)) {
        const pr = new HocuspocusProvider({ websocketProvider: shared, document: new Y.Doc(), name: id, token });
        pr.attach(); providers.push(pr);
        clients.push({ destroy: () => { pr.destroy(); } });
      }
    }
    await eventually(() => providers.every((x) => x.isAuthenticated), 30_000, '300 documents authenticated');
    await eventually(() => r.host.hocuspocus?.getDocumentsCount() === 300, 30_000, '300 documents loaded');
    const before = r.facts.length;
    await eventually(() => r.facts.length >= before + 3, 15_000, 'three rounds');
    const rounds = r.facts.slice(before);
    expect(rounds.every((n) => n === 300)).toBe(true); // every round: all 300 documents, in one query each
    expect(providers.every((x) => x.isAuthenticated)).toBe(true);
  }, 90_000);
});
