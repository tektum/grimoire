// Helpers of the sign-in end-to-end test. They extend the collaboration harness (../support.ts: scenario runner, peers, Compose helper, runtime database handle):
// the stack runs OUTSIDE local mode with the real Descope adapter (compose.m3.yaml), tokens come from the local key server (tools/m3-keyserver),
// users, collections and pages are created through the real tables (as the administrator or the runtime role), never by loosening authorisation.
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { DEV_COLLECTION, ORIGIN, WS_URL, compose, eventually, newPage, originSocket, peer, repoRoot, storedText, closeDb, scenario, waitUntil } from '../support.ts';
import type { Peer, T } from '../support.ts';

// The collaboration runner writes to test-results/m1 unless told otherwise: the scenarios of these scenarios write to test-results/m3.
process.env['E2E_RESULTS_DIR'] ??= 'test-results/m3';

export { DEV_COLLECTION, closeDb, eventually, newPage, scenario, storedText };
export type { Peer, T };

/** The project id the key server signs for and the app expects (compose.m3.yaml); override with M3_PROJECT_ID for a differently configured stack. */
export const PROJECT_ID = process.env['M3_PROJECT_ID'] ?? 'P2m3exittestprojectabcdefghij';
const KEYSERVER = { hostname: '127.0.0.1', port: 58443 };
const CA = (): Buffer => readFileSync(path.join(repoRoot, 'test-results/m3/pki/ca.pem'));

export type Variant = 'good' | 'expired' | 'wrong-issuer' | 'refresh' | 'other-key';
export interface TokenRequest { readonly sub: string; readonly variant?: Variant; readonly ttlSeconds?: number; readonly claims?: Record<string, unknown> }

function request(method: 'GET' | 'POST', url: string, payload?: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request({ ...KEYSERVER, path: url, method, ca: CA(), headers: { 'content-type': 'application/json' } }, (res) => {
      let body = ''; res.on('data', (c: Buffer) => { body += c.toString(); });
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, body }); });
    });
    req.on('error', reject);
    req.end(payload === undefined ? undefined : JSON.stringify(payload));
  });
}

/** A session token from the key server (deliberately defective variants included). */
export async function tokenFor(r: TokenRequest): Promise<string> {
  const res = await request('POST', '/control/token', r);
  const parsed: unknown = JSON.parse(res.body);
  const token = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'token') : undefined;
  if (res.status !== 200 || typeof token !== 'string') throw new Error(`key server refused to sign (${String(res.status)}): ${res.body}`);
  return token;
}

/** Waits until the key server and the app (outside local mode) both answer. */
export async function waitStack(timeoutMs = 90_000): Promise<void> {
  await eventually(async () => {
    try { return (await request('GET', '/healthz')).status === 200 ? true : undefined; } catch { return undefined; }
  }, timeoutMs, 'the key server to answer /healthz');
  await eventually(async () => {
    try { return (await fetch('http://127.0.0.1:8080/readyz')).ok ? true : undefined; } catch { return undefined; }
  }, timeoutMs, 'the app to answer /readyz');
}

// ---- database (administrator through the postgres container; the runtime handle of ../support.ts reads pages) ------------------------------

const psql = async (sql: string): Promise<string> => compose('exec', '-T', 'postgres', 'psql', '-U', 'grimoire_admin', '-d', 'grimoire', '-v', 'ON_ERROR_STOP=1', '-tA', '-c', sql);
const lit = (s: string): string => `'${s.replaceAll("'", "''")}'`;
/** One scalar from a query (psql prints it first; extra command-tag lines of INSERT/UPDATE are ignored). */
export async function scalar(sql: string): Promise<string> { return (await psql(sql)).split('\n')[0]?.trim() ?? ''; }

export interface UserSpec { readonly sub: string; readonly role?: 'member' | 'admin' | 'viewer'; readonly suspended?: boolean }
/** Creates (idempotently) a user row the way sign-in would, with the column set the committed tests use. */
export async function createUser(u: UserSpec): Promise<void> {
  const role = u.role ?? 'member';
  await psql(`insert into users (id, descope_user_id, email, name, role, suspended_at) values (gen_random_uuid(), ${lit(u.sub)}, ${lit(`${u.sub.toLowerCase()}@example.test`)}, ${lit(u.sub)}, ${lit(role)}, ${u.suspended === true ? 'now()' : 'null'}) on conflict (descope_user_id) do update set suspended_at = excluded.suspended_at`);
}
export async function userRows(sub: string): Promise<number> { return Number(await scalar(`select count(*) from users where descope_user_id = ${lit(sub)}`)); }
/** A subject that no earlier run has used. */
export const freshSub = (prefix: string): string => `U2m3${prefix}${randomBytes(4).toString('hex')}`;

// ---- clients -----------------------------------------------------------------------------------------------------------------------------

/** What a connection attempt ended in: the refusal reason the client saw, or the scope the server granted. */
export async function attempt(page: string, label: string, token: string, text?: string): Promise<{ readonly peer: Peer; readonly outcome: string }> {
  const p = peer(page, label, 'member', { token });
  // Typed before the handshake finishes: had the server admitted this client, the edit would be stored.
  if (text !== undefined) p.text.insert(0, text);
  await eventually(() => (p.provider.isAuthenticated || p.failures.length > 0 || p.closes.length > 0 ? true : undefined), 10_000, `${label} answered`);
  const outcome = p.failures[0] ?? (p.provider.isAuthenticated ? p.provider.authorizedScope ?? 'authenticated' : 'closed');
  return { peer: p, outcome };
}

/** The mutation the proof run asks for (`make test-m3-mutation`): a scenario breaks one protection from outside, at the marked place, and must then FAIL. Empty in a normal run. */
export const MUTATION = process.env['M3_MUTATION'] ?? '';
export async function setDefaultPermission(collection: string, permission: 'read' | 'read_write' | null): Promise<void> { await psql(`update collections set default_permission = ${permission === null ? 'null' : lit(permission)} where id = '${collection}'`); }

/** What the refused or closed client saw first: the code and the reason string of its first close. */
export const firstClose = (p: Peer, timeoutMs: number, what: string): Promise<{ readonly code: number; readonly reason: string }> =>
  eventually(() => p.closed[0], timeoutMs, what);

/** A client that signed in and holds a synced page; the granted scope is the first thing asserted. */
export async function signedIn(page: string, label: string, token: string | (() => string), scope: 'read-write' | 'readonly'): Promise<Peer> {
  const p = peer(page, label, 'member', { token });
  await eventually(() => (p.provider.isAuthenticated && p.provider.synced ? true : p.failures.length > 0 || p.closed.length > 0 ? true : undefined), 15_000, `${label} signed in`);
  if (p.failures.length > 0 || p.closed.length > 0 || p.provider.authorizedScope !== scope) {
    p.destroy();
    throw new Error(`${label}: expected a signed-in ${scope} client, got ${p.failures[0] ?? p.closed[0]?.reason ?? String(p.provider.authorizedScope)}`);
  }
  return p;
}

/** Waits `ms` while the condition keeps holding: throws (with `what`) the moment it does not. A negative proof ("nobody was closed") needs elapsed time, not a sleep. */
export async function holds(ms: number, still: () => boolean, what: string): Promise<void> {
  if (await waitUntil(() => !still(), ms)) throw new Error(`${what}: stopped holding within ${String(ms)} ms`);
}

// ---- collections and grants (administrator) ---------------------------------------------------------------------------------------------
const SYSTEM_USER = '00000000-0000-4000-8000-000000000001';
export async function userId(sub: string): Promise<string> { return scalar(`select id from users where descope_user_id = ${lit(sub)}`); }
/** A collection; `defaultPermission` null makes it CLOSED (only users with an entry, and administrators, reach it). */
export async function createCollection(name: string, defaultPermission: 'read' | 'read_write' | null): Promise<string> {
  const id = randomUUID();
  await psql(`insert into collections (id, name, position, default_permission, created_by) values ('${id}', ${lit(name)}, 'b0', ${defaultPermission === null ? 'null' : lit(defaultPermission)}, '${SYSTEM_USER}')`);
  return id;
}
export async function createPageIn(collection: string): Promise<string> {
  const id = randomUUID();
  await psql(`insert into pages (id, collection_id) values ('${id}', '${collection}')`);
  return id;
}
export async function grant(collection: string, sub: string, permission: 'read' | 'read_write'): Promise<void> {
  await psql(`insert into collection_access (collection_id, user_id, permission) select '${collection}', id, ${lit(permission)} from users where descope_user_id = ${lit(sub)} on conflict (collection_id, user_id) where user_id is not null do update set permission = excluded.permission`);
}
export async function revoke(collection: string, sub: string): Promise<void> {
  await psql(`delete from collection_access where collection_id = '${collection}' and user_id = (select id from users where descope_user_id = ${lit(sub)})`);
}
export async function setRole(sub: string, role: 'member' | 'admin' | 'viewer'): Promise<void> { await psql(`update users set role = ${lit(role)} where descope_user_id = ${lit(sub)}`); }
export async function setSuspended(sub: string, suspended: boolean): Promise<void> { await psql(`update users set suspended_at = ${suspended ? 'now()' : 'null'} where descope_user_id = ${lit(sub)}`); }

// ---- documents on one shared socket; raw sockets before sign-in ------------------------------------------------------------------------

export interface Doc { readonly provider: HocuspocusProvider; readonly failures: string[]; readonly closed: { code: number; reason: string }[]; destroy(): void }
/** One WebSocket that several documents share (the per-user DOCUMENT cap counts sessions, the socket cap counts sockets). */
export const sharedSocket = (): HocuspocusProviderWebsocket => new HocuspocusProviderWebsocket({ url: WS_URL, WebSocketPolyfill: originSocket(ORIGIN) });
export function openDoc(socket: HocuspocusProviderWebsocket, page: string, token: string): Doc {
  const failures: string[] = []; const closed: { code: number; reason: string }[] = [];
  const provider = new HocuspocusProvider({
    name: page, token, document: new Y.Doc(), websocketProvider: socket,
    onAuthenticationFailed: ({ reason }) => { failures.push(reason); },
    onClose: ({ event }) => { closed.push({ code: event.code, reason: event.reason }); },
  });
  provider.attach();
  return { provider, failures, closed, destroy: () => { provider.destroy(); } };
}

export interface RawSocket {
  /** 101 when the upgrade was accepted, else the refusal status. */
  readonly status: number;
  readonly retryAfter: string | undefined;
  /** The close frame the server wrote (code and reason), or code 0 when the socket ended without one. Never settles for a refused upgrade. */
  readonly closing: Promise<{ readonly code: number; readonly reason: string }>;
  destroy(): void;
}
/** An upgrade request to /collab that never signs in (no frame is ever sent): what a socket in the pre-sign-in window looks like. */
export function rawSocket(): Promise<RawSocket> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: 8080, path: '/collab', agent: false, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': randomBytes(16).toString('base64'), Origin: ORIGIN } });
    req.on('upgrade', (_res, socket) => {
      const closing = new Promise<{ code: number; reason: string }>((done) => {
        let buf = Buffer.alloc(0);
        socket.on('data', (d: Buffer) => {
          buf = Buffer.concat([buf, d]);
          const len = (buf[1] ?? 0) & 0x7f;
          if (buf.length >= 4 && buf[0] === 0x88 && buf.length >= 2 + len) done({ code: buf.readUInt16BE(2), reason: buf.subarray(4, 2 + len).toString() });
        });
        socket.on('close', () => { done({ code: 0, reason: 'ended without a close frame' }); });
        socket.on('error', () => { done({ code: 0, reason: 'socket error' }); });
      });
      resolve({ status: 101, retryAfter: undefined, closing, destroy: () => { socket.destroy(); } });
    });
    req.on('response', (res) => {
      res.resume();
      const ra = res.headers['retry-after'];
      resolve({ status: res.statusCode ?? 0, retryAfter: Array.isArray(ra) ? ra[0] : ra, closing: new Promise(() => undefined), destroy: () => { res.destroy(); } });
    });
    req.on('error', reject);
    req.end();
  });
}

// ---- stack changes (restored by the scenario that made them) -------------------------------------------------------------------------
export const stopService = (name: 'keyserver' | 'postgres'): Promise<string> => compose('stop', name);
export const startService = (name: 'keyserver' | 'postgres'): Promise<string> => compose('start', name);
