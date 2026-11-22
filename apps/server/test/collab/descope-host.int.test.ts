import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDescopeVerifier } from '@tektum/grimoire-adapter-auth-descope';
import type { DescopeVerifier } from '@tektum/grimoire-adapter-auth-descope';
import { createCollabHost } from '@tektum/grimoire-adapter-collab-hocuspocus';
import type { HocuspocusCollabHost } from '@tektum/grimoire-adapter-collab-hocuspocus';
import { createAccessStore, createDatabase, createPageStore, createUserStore } from '@tektum/grimoire-adapter-db-kysely';
import type { KyselyDatabase } from '@tektum/grimoire-adapter-db-kysely';
import { createPageAccess } from '@tektum/grimoire-core/authorize';
import { createProvisioner } from '@tektum/grimoire-core/users/provisioner';
import { makeFakeConfig } from '@tektum/grimoire-core/testing/fake-config';
import { FakeLogger } from '@tektum/grimoire-core/testing/fake-logger';
import { FakeMarkdownConverter } from '@tektum/grimoire-core/testing/fake-markdown-converter';
import { appUrl, createTestDatabase, dropTestDatabase, requireBuild, sqlAdmin } from '../server/support/harness.js';
import { createIssuer, KeyService, PROJECT_ID } from '../server/support/descope-double.js';
import type { Issuer } from '../server/support/descope-double.js';
import { connect, DEV_COLLECTION, devFixtures, eventually, StallProxy } from './support.js';
import type { Client } from './support.js';

// The production wiring outside local mode (Descope verifier, user lookup without provisioning, database authoriser) against a local
// key-service double that signs tokens, and the real database. The server binary cannot be used for this: outside local mode the
// base URL must be https (contracts section 6), so the host is assembled here exactly as composition.ts assembles it.
const DB = 'grimoire_t06_descope';
const ATTEMPTS = 3;
const CLOSED = '00000000-0000-4000-8000-0000000000da';
const SYSTEM = '00000000-0000-4000-8000-000000000001';
let issuer: Issuer;
const clients: Client[] = [];
const stops: (() => Promise<void>)[] = [];

interface Rig { readonly url: string; readonly keys: KeyService; readonly logger: FakeLogger; readonly host: HocuspocusCollabHost; readonly db: KyselyDatabase }
async function rig(o: { dbUrl?: string; attempts?: number } = {}): Promise<Rig> {
  const keys = new KeyService(issuer); await keys.start();
  const logger = new FakeLogger();
  const clock = { now: () => Date.now() };
  const verifier: DescopeVerifier = createDescopeVerifier({ projectId: PROJECT_ID, baseUrl: keys.baseUrl, logger, clock, maxTokenLifetimeMs: 3_600_000, failureBackoffMs: 0 });
  const db = createDatabase(o.dbUrl ?? appUrl(DB), { maxConnections: 4, queryTimeoutMs: 1500, connectionTimeoutMs: 1500 });
  const users = createUserStore(db);
  const host = createCollabHost();
  await host.start({
    config: makeFakeConfig({ collab: { connectAttemptsPerWindow: o.attempts ?? 1000 } }), logger, clock, verifier,
    resolveUser: (_t, identity) => users.findByDescopeId(identity.userId),
    access: createPageAccess(createAccessStore(db)), pages: createPageStore(db, clock),
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
  return { url: `ws://127.0.0.1:${String((server.address() as AddressInfo).port)}/collab`, keys, logger, host, db };
}
const open = (r: Rig, page: string, token: string): Client => { const c = connect(r.url, page, token, { maxAttempts: 1 }); clients.push(c); return c; };
async function outcome(r: Rig, page: string, token: string): Promise<string> {
  const c = open(r, page, token);
  // A client without a token never sends one: the pre-sign-in window (5 s) closes it with no reason, reported as 'closed'.
  await eventually(() => c.provider.isAuthenticated || c.closes.length > 0, 8000, 'answered');
  const result = c.failures[0] ?? (c.provider.isAuthenticated ? c.provider.authorizedScope : undefined) ?? (c.provider.synced ? 'synced-without-sign-in' : 'closed');
  c.destroy();
  return result;
}
async function user(sub: string, role: string, extra = ''): Promise<string> {
  const id = randomUUID();
  await sqlAdmin(DB, `insert into users (id, descope_user_id, email, name, role${extra ? ', suspended_at' : ''}) values ('${id}', '${sub}', '${sub.toLowerCase()}@example.test', '${sub}', '${role}'${extra ? `, ${extra}` : ''})`);
  return id;
}
async function page(collection = DEV_COLLECTION): Promise<string> {
  const id = randomUUID();
  await sqlAdmin(DB, `insert into pages (id, collection_id) values ('${id}', '${collection}')`);
  return id;
}
const now = (): number => Math.floor(Date.now() / 1000);
const profileClaims = (email: string) => ({ email, name: 'N', emailVerified: true });

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

describe('Descope verifier + database authoriser (production wiring, local key-service double)', () => {
  it('token matrix: none, malformed, expired, wrong issuer, refresh token -> invalid-token; write access -> read-write', async () => {
    const r = await rig();
    await user('U2writer', 'member');
    const p = await page();
    expect(await outcome(r, p, '')).toMatch(/^(invalid-token|closed)$/);
    expect(await outcome(r, p, 'not.a.jwt')).toBe('invalid-token');
    expect(await outcome(r, p, await issuer.token('U2writer', { exp: now() - 60, iat: now() - 120 }))).toBe('invalid-token');
    expect(await outcome(r, p, await issuer.token('U2writer', { iss: 'someone-else' }))).toBe('invalid-token');
    expect(await outcome(r, p, await issuer.token('U2writer', { drn: 'DSR' }))).toBe('invalid-token');
    expect(await outcome(r, p, await issuer.token('U2writer'))).toBe('read-write');
  }, 30_000);

  it('unknown user in an allowed domain: refused forbidden on the WebSocket and no row is written; after provisioning (what GET /v1/me does) it connects with the default role', async () => {
    const r = await rig();
    const p = await page();
    const token = await issuer.token('U2newcomer', profileClaims('newcomer@example.test'));
    expect(await outcome(r, p, token)).toBe('forbidden');
    expect(await sqlAdmin(DB, "select 1 from users where descope_user_id = 'U2newcomer'")).toEqual([]);
    const verifier = createDescopeVerifier({ projectId: PROJECT_ID, baseUrl: r.keys.baseUrl, logger: new FakeLogger(), clock: { now: () => Date.now() } });
    const v = await verifier.verify(token); verifier.close();
    if (v.kind !== 'ok') throw new Error('token should verify');
    const provisioner = createProvisioner({ users: createUserStore(r.db), verifier, policy: { firstAdminEmails: [], allowedEmailDomains: ['example.test'], allowDevRole: false } });
    expect(await provisioner.signIn({ identity: { userId: v.userId, ...(v.profile ? { profile: v.profile } : {}) } })).toMatchObject({ kind: 'ok', created: true, user: { role: 'member' } });
    expect(await outcome(r, p, token)).toBe('read-write');
  }, 30_000);

  it('disallowed domain: provisioning refuses, so the WebSocket keeps refusing forbidden', async () => {
    const r = await rig();
    const p = await page();
    const token = await issuer.token('U2outsider', profileClaims('x@elsewhere.test'));
    const provisioner = createProvisioner({ users: createUserStore(r.db), verifier: { verify: () => Promise.resolve({ kind: 'invalid-token' }) }, policy: { firstAdminEmails: [], allowedEmailDomains: ['example.test'], allowDevRole: false } });
    expect(await provisioner.signIn({ identity: { userId: 'U2outsider', profile: { ...profileClaims('x@elsewhere.test') } } })).toMatchObject({ kind: 'refused', reason: 'domain-not-allowed' });
    expect(await outcome(r, p, token)).toBe('forbidden');
  }, 30_000);

  it('suspended -> forbidden; no access -> not-found, identical to a missing page; read entry -> read-only and its writes are dropped', async () => {
    const r = await rig();
    await user('U2gone', 'admin', 'now()');
    const reader = await user('U2reader', 'member');
    await user('U2writer2', 'member');
    const closed = await page(CLOSED);
    const p = await page();
    expect(await outcome(r, p, await issuer.token('U2gone'))).toBe('forbidden');
    const hidden = open(r, closed, await issuer.token('U2writer2'));
    const missing = open(r, randomUUID(), await issuer.token('U2writer2'));
    await eventually(() => hidden.closes.length > 0 && missing.closes.length > 0, 5000, 'both refused');
    expect(hidden.failures).toEqual(['not-found']);
    expect({ f: hidden.failures, c: hidden.closes }).toStrictEqual({ f: missing.failures, c: missing.closes });
    await sqlAdmin(DB, `insert into collection_access (collection_id, user_id, permission) values ('${CLOSED}', '${reader}', 'read')`);
    expect(await outcome(r, closed, await issuer.token('U2writer2'))).toBe('not-found');
    const ro = open(r, closed, await issuer.token('U2reader'));
    await eventually(() => ro.provider.synced, 5000, 'reader synced');
    expect(ro.provider.authorizedScope).toBe('readonly');
    ro.text.insert(0, 'reader text');
    await eventually(() => r.host.hocuspocus?.documents.get(closed) !== undefined, 5000, 'document open');
    ro.provider.awareness?.setLocalState({ marker: 1 });
    await eventually(() => r.host.hocuspocus?.documents.get(closed)?.awareness.getStates().get(ro.document.clientID)?.['marker'] === 1, 5000, 'frames handled');
    expect(r.host.hocuspocus?.documents.get(closed)?.getText('prosemirror').toString()).toBe('');
    ro.destroy();
    await eventually(() => r.host.hocuspocus?.documents.size === 0, 10_000, 'unloaded');
    expect(await sqlAdmin(DB, `select ydoc from pages where id = '${closed}'`)).toEqual([{ ydoc: null }]);
  }, 30_000);

  it('key service down (keys never fetched): try-again, more often than the attempt limit, and never a ban', async () => {
    const r = await rig({ attempts: ATTEMPTS });
    await user('U2early', 'member');
    const p = await page();
    r.keys.down = true;
    const token = await issuer.token('U2early');
    for (let i = 0; i < ATTEMPTS + 2; i++) expect(await outcome(r, p, token)).toBe('try-again');
    expect(r.logger.entries.filter((e) => e.event === 'collab.upgrade_refused')).toEqual([]);
    r.keys.down = false;
    await eventually(async () => ((await outcome(r, p, token)) === 'read-write' ? true : undefined), 10_000, 'admitted after recovery');
  }, 30_000);

  it('database down during authorisation: try-again, never admitted, never a ban', async () => {
    const proxy = await StallProxy.start(); stops.push(() => proxy.stop());
    const r = await rig({ dbUrl: proxy.url(DB), attempts: ATTEMPTS });
    await user('U2stall', 'member');
    const p = await page();
    const token = await issuer.token('U2stall');
    expect(await outcome(r, p, token)).toBe('read-write');
    proxy.stall();
    for (let i = 0; i < ATTEMPTS + 2; i++) expect(await outcome(r, p, token)).toBe('try-again');
    expect(r.logger.entries.filter((e) => e.event === 'collab.upgrade_refused')).toEqual([]);
    proxy.release();
  }, 60_000);
});
