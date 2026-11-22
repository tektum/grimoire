// Helpers of the sign-in end-to-end test. They extend the collaboration harness (../support.ts: scenario runner, peers, Compose helper, runtime database handle):
// the stack runs OUTSIDE local mode with the real Descope adapter (compose.m3.yaml), tokens come from the local key server (tools/m3-keyserver),
// users, collections and pages are created through the real tables (as the administrator or the runtime role), never by loosening authorisation.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { DEV_COLLECTION, compose, eventually, newPage, peer, repoRoot, storedText, closeDb, scenario } from '../support.ts';
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
