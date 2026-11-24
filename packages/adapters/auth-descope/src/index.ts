// Descope session-token verifier: the official Node SDK (pinned exactly) validates the signature and claims, Grimoire's policy sits on top, and the SDK's only door to the network is a guarded `fetch`.
// Known properties, accepted: the SDK's cache timings are fixed (10 min key cache, 30 s unknown-kid cooldown, 1 h maximum key age; so after the provider rotates keys, a token signed by the new key may be refused for up to 30 s on a server that fetched keys just before, pinned by contract.test.ts), and the SDK takes no algorithm list, so RS256 is pinned by our own header check;
// expiry is checked on both clocks (the SDK on the system clock, we again on the injected one).
// Possible simplification: the usable-key filter in the guarded fetch could move into the SDK path (not done now).
import DescopeClient from '@descope/node-sdk';
import type { Clock } from '@tektum/grimoire-core/ports/clock';
import type { Logger } from '@tektum/grimoire-core/ports/logger';
import { isDescopeProjectId, type AuthVerifier, type Profile, type ProfileResult, type VerifyResult } from '@tektum/grimoire-core/ports/auth-verifier';

export interface DescopeVerifierOptions {
  projectId: string;
  baseUrl?: string | undefined;
  managementKey?: string | undefined;
  logger: Logger;
  clock: Clock;
  /** Accepted `iss` values (exact match, checked by us: the SDK alone also accepts project URLs). Default: the project id [contracts section 3]. The SDK's own check comes first and only lets through the project id or a URL ending in it, so this list can only narrow that set, never widen it. */
  issuers?: string[] | undefined;
  /** When set, `aud` must match exactly (the SDK checks it); default is no audience check (`aud` is absent by default). */
  audience?: string | undefined;
  fetchTimeoutMs?: number | undefined;
  /** After a failed key fetch no new fetch is made for this long (bounds load on Descope while it is down). */
  failureBackoffMs?: number | undefined;
  /** Largest accepted remaining lifetime (exp - now). Default 24 h: conservative, Descope documents no session-token maximum. */
  maxTokenLifetimeMs?: number | undefined;
}

/** The management profile lookup is optional on the port; this adapter always has it (it answers `not-configured` without a key). */
export type DescopeVerifier = AuthVerifier & Required<Pick<AuthVerifier, 'profile'>> & { close(): void };

/** Whole-token length bound, checked before any parsing or network call (security review N2). */
const MAX_TOKEN_LENGTH = 8192;
/** A key set is a few hundred bytes per key; anything above this is refused unread. */
const MAX_KEYS_BYTES = 256 * 1024;
const MAX_PROFILE_BYTES = 64 * 1024;
const CLOCK_TOLERANCE_SECONDS = 5;
/** Documented session-token `drn` value (docs.descope.com/management/token: "typically DS"); the refresh value is not documented, so every other value is refused. */
const SESSION_DRN = 'DS';
/** The unavailable-keys error is logged at most this often. */
const UNAVAILABLE_LOG_EVERY_MS = 30_000;
const KEYS_PATH = '/v2/keys/';
const USER_PATH = '/v1/mgmt/user';
/** sub: 1-256 characters, no control characters (C0, DEL, C1), no leading or trailing whitespace. Descope ids are short alphanumerics, so this is wider. */
const hasControl = (v: string): boolean => [...v].some((c) => { const n = c.codePointAt(0) ?? 0; return n <= 0x1f || (n >= 0x7f && n <= 0x9f); });
/** A key we can verify with: an RSA signing key for RS256 with a sound base64url modulus (at least 2048 bits) and exponent. */
const B64URL = /^[A-Za-z0-9_-]+$/;
function usableKey(k: unknown): boolean {
  if (!isRecord(k) || k['kty'] !== 'RSA') return false;
  if (k['alg'] !== undefined && k['alg'] !== 'RS256') return false;
  if (k['use'] !== undefined && k['use'] !== 'sig') return false;
  if (typeof k['kid'] !== 'string' || k['kid'] === '') return false;
  const { n, e } = k;
  return typeof n === 'string' && typeof e === 'string' && B64URL.test(n) && B64URL.test(e) && Buffer.from(n, 'base64url').byteLength >= 256;
}
const isInt = (v: unknown): v is number => Number.isSafeInteger(v);
const INVALID: VerifyResult = { kind: 'invalid-token' };
const UNAVAILABLE: VerifyResult = { kind: 'service-unavailable' };

type FailReason = 'timeout' | 'http' | 'invalid' | 'network';
class KeysInvalid extends Error {}
class KeysHttp extends Error {}
class KeysBackoff extends Error {}
class Blocked extends Error {}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isTimeout = (e: unknown): boolean => e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
const reasonOf = (e: unknown): FailReason => (isTimeout(e) ? 'timeout' : e instanceof KeysInvalid ? 'invalid' : e instanceof KeysHttp ? 'http' : 'network');

/** Region from the project id, never per-project code branches [F§10]. */
export function descopeBaseUrl(projectId: string, baseUrl?: string): string {
  if (baseUrl !== undefined && baseUrl !== '') {
    let u: URL;
    try { u = new URL(baseUrl); } catch { throw new Error('baseUrl is not a valid URL'); }
    const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
    if (!(u.protocol === 'https:' || (u.protocol === 'http:' && loopback))) throw new Error('baseUrl must be https (http only for loopback)');
    if (u.username !== '' || u.password !== '' || u.search !== '' || u.hash !== '') throw new Error('baseUrl must not carry credentials, query or fragment');
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  }
  const region = projectId.slice(1, -27);
  return region === '' ? 'https://api.descope.com' : `https://api.${region}.descope.com`;
}

/** Reads at most `max` bytes (neither fetch nor the SDK bounds the body). */
async function readBounded(res: Response, max: number): Promise<string> {
  const declared = res.headers.get('content-length');
  if (declared !== null && Number(declared) > max) {
    await res.body?.cancel();
    throw new KeysInvalid();
  }
  const reader = res.body?.getReader();
  if (reader === undefined) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new KeysInvalid();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Hand-written (the claim shape is ours, not the SDK's): signed top-level claims only; anything wrongly typed gives no profile. */
function profileFromClaims(p: Record<string, unknown>): Profile | undefined {
  const { email, name, emailVerified, picture } = p;
  if (typeof email !== 'string' || email === '' || email.length > 320) return undefined;
  if (typeof name !== 'string' || name.length > 200 || typeof emailVerified !== 'boolean') return undefined;
  const avatar = typeof picture === 'string' && picture.length <= 2048 && picture.startsWith('https://') ? { avatarUrl: picture } : {};
  return { email, name: name === '' ? email : name, emailVerified, ...avatar };
}

/** The decoded JSON of one compact-JWT segment (no verification: only used on a token the SDK has already verified, or to refuse early). */
function segment(token: string, index: number): Record<string, unknown> | undefined {
  try {
    const v: unknown = JSON.parse(Buffer.from(String(token.split('.')[index]), 'base64url').toString('utf8'));
    return isRecord(v) ? v : undefined;
  } catch { return undefined; }
}

/**
 * EVERY assumption about the shape of the errors `validateJwt` of the Descope SDK throws lives here (read from @descope/node-sdk 2.22.0, lib/index.ts):
 *  1. A token problem (bad signature, expired, malformed, wrong claim or audience) is a raw `jose` error: an Error with a string `code` that starts `ERR_J` (jose 5.2.2).
 *  2. A token without a key id throws `Error('header.kid must not be empty')` (no code).
 *  3. "No key matches" throws `Error('failed to fetch matching key')` (no code), for BOTH an unknown key id and an outage: our own key-fetch flag tells them apart.
 * Anything else is 'unrecognised': the caller refuses it and logs it. The contract tests (test/contract.test.ts) drive the real SDK through each case, so an SDK upgrade that changes a shape fails there.
 */
export function classifySdkError(e: unknown): 'token' | 'no-key' | 'unrecognised' {
  if (!(e instanceof Error)) return 'unrecognised';
  const { code } = e as { code?: unknown };
  if (typeof code === 'string') return /^ERR_J/.test(code) ? 'token' : 'unrecognised';
  if (e.message === 'header.kid must not be empty') return 'token';
  if (e.message === 'failed to fetch matching key') return 'no-key';
  return 'unrecognised';
}

export function createDescopeVerifier(o: DescopeVerifierOptions): DescopeVerifier {
  if (typeof o.projectId !== 'string' || o.projectId === '') throw new Error('Descope project id is required');
  if (!isDescopeProjectId(o.projectId)) throw new Error('Descope project id must be alphanumeric');
  const { projectId, logger, clock } = o;
  const base = descopeBaseUrl(projectId, o.baseUrl);
  const fetchTimeoutMs = o.fetchTimeoutMs ?? 3000;
  const maxLifetimeMs = o.maxTokenLifetimeMs ?? 24 * 3_600_000;
  const failureBackoffMs = o.failureBackoffMs ?? 5000;
  const issuers = o.issuers !== undefined && o.issuers.length > 0 ? o.issuers : [projectId];
  const doFetch = globalThis.fetch.bind(globalThis);
  const keysUrl = `${base}${KEYS_PATH}${projectId}`;
  const userUrl = `${base}${USER_PATH}`;

  /** Outcome of the latest key fetch: the SDK hides it, but it is what separates an outage from a bad token. */
  let keysHealthy = true;
  let blockedUntil = 0;
  let lastUnavailableLog = Number.NEGATIVE_INFINITY;
  let lastUnexpectedLog = Number.NEGATIVE_INFINITY;

  const keysFailed = (e: unknown): void => {
    keysHealthy = false;
    blockedUntil = clock.now() + failureBackoffMs;
    logger.warn('auth.keys_reload_failed', { reason: reasonOf(e) });
  };

  /**
   * The only door to the network, handed to the SDK as its `fetch`: it allows the key-set and load-user addresses of the configured base only,
   * never follows a redirect, bounds time and body size, and turns every non-200 into a thrown error (so the SDK's own retry-with-sleeps on 503 never runs).
   * A key set holding no usable key is refused as a whole (the SDK then keeps its previous keys); unusable keys are removed before the SDK sees them.
   */
  const guardedFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const raw = String(input); // the SDK passes a string; anything else becomes text that is neither address
    const isKeys = init?.method === 'GET' && raw === keysUrl;
    const isUser = init?.method === 'GET' && raw.startsWith(`${userUrl}?`);
    if (!isKeys && !isUser) throw new Blocked(); // includes the SDK's licence handshake at construction
    if (isKeys && clock.now() < blockedUntil) throw new KeysBackoff();
    try {
      const res = await doFetch(raw, { ...init, redirect: 'manual', signal: AbortSignal.timeout(fetchTimeoutMs) });
      if (res.status !== 200) {
        await res.body?.cancel();
        throw new KeysHttp();
      }
      const text = await readBounded(res, isKeys ? MAX_KEYS_BYTES : MAX_PROFILE_BYTES);
      let out = text;
      if (isKeys) {
        const parsed: unknown = JSON.parse(text);
        const usable = isRecord(parsed) && Array.isArray(parsed['keys']) ? parsed['keys'].filter(usableKey) : [];
        if (usable.length === 0) throw new KeysInvalid(); // a set without a usable key never replaces the cache nor counts as a good fetch
        out = JSON.stringify({ keys: usable });
        keysHealthy = true;
        blockedUntil = 0;
      }
      return new Response(out, { status: 200, headers: { 'content-type': 'application/json' } });
    } catch (e) {
      const err = e instanceof SyntaxError ? new KeysInvalid() : e;
      if (isKeys) keysFailed(err);
      throw err;
    }
  };

  const sdk = DescopeClient({
    projectId,
    baseUrl: base,
    fetch: guardedFetch,
    managementKey: o.managementKey as string, // undefined or empty means no management client: the SDK tests the value for truth
  });

  async function verify(token: string): Promise<VerifyResult> {
    if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) return INVALID;
    // The SDK accepts every algorithm its key type fits: RS256 only is ours, refused before any key lookup.
    if (segment(token, 0)?.['alg'] !== 'RS256') return INVALID;
    let verified: { token: Record<string, unknown> };
    try {
      verified = await sdk.validateJwt(token, { audience: o.audience as string }); // undefined means no audience check: the SDK tests the value for truth
    } catch (e) {
      const kind = classifySdkError(e);
      if (kind === 'token') return INVALID;
      if (kind === 'unrecognised') {
        // Default-safe: never accepted; an outage (our own key-fetch flag) must not look like a bad token; an operator is told, once per cooldown, by name only (never the token).
        if (clock.now() - lastUnexpectedLog >= UNAVAILABLE_LOG_EVERY_MS) {
          lastUnexpectedLog = clock.now();
          logger.error('auth.sdk_unexpected_error', { name: e instanceof Error ? e.name : typeof e });
        }
        return keysHealthy ? INVALID : UNAVAILABLE;
      }
      // 'no-key': an unknown kid, or no key to check against (never fetched, or older than the SDK's one-hour limit).
      // Only a failed key fetch of ours makes that an outage.
      if (keysHealthy) return INVALID;
      if (clock.now() - lastUnavailableLog >= UNAVAILABLE_LOG_EVERY_MS) {
        lastUnavailableLog = clock.now();
        logger.error('auth.keys_unavailable');
      }
      return UNAVAILABLE;
    }
    const now = clock.now();
    const payload = verified.token;
    const { sub, exp, iat, nbf, drn } = payload;
    // The SDK overwrites `iss` with the project id and accepts project URLs: the exact issuer is checked on the signed payload.
    const iss = Object(segment(token, 1))['iss'] as string;
    if (!issuers.includes(iss)) return INVALID;
    if (drn !== SESSION_DRN) return INVALID;
    if (typeof sub !== 'string' || sub === '' || sub.length > 256 || hasControl(sub) || sub !== sub.trim()) return INVALID;
    if (!isInt(exp) || !isInt(iat) || iat < 0 || (nbf !== undefined && !isInt(nbf))) return INVALID;
    // Expiry and not-before on OUR clock (the SDK uses the system clock), the issued lifetime and the remaining lifetime both bounded, no future iat.
    if (exp * 1000 + CLOCK_TOLERANCE_SECONDS * 1000 <= now) return INVALID;
    if ((nbf ?? 0) * 1000 - CLOCK_TOLERANCE_SECONDS * 1000 > now) return INVALID;
    if ((exp - iat) * 1000 > maxLifetimeMs || exp * 1000 - now > maxLifetimeMs) return INVALID;
    if (iat * 1000 > now + CLOCK_TOLERANCE_SECONDS * 1000) return INVALID;
    const profile = profileFromClaims(payload);
    return profile === undefined ? { kind: 'ok', userId: sub, expiresAt: exp * 1000 } : { kind: 'ok', userId: sub, expiresAt: exp * 1000, profile };
  }

  const managementKey = o.managementKey;
  async function profile(userId: string): Promise<ProfileResult> {
    if (managementKey === undefined || managementKey === '') return { kind: 'not-configured' };
    if (typeof userId !== 'string' || userId === '' || userId.length > 256) return { kind: 'unavailable' };
    const fail = (reason: FailReason): ProfileResult => {
      logger.warn('auth.profile_failed', { reason });
      return { kind: 'unavailable' };
    };
    try {
      const res = await sdk.management.user.loadByUserId(userId);
      const user: unknown = res.data; // a non-200 never gets here: the guard throws on it
      if (!isRecord(user)) return fail('invalid');
      const name = user['name'];
      const p = profileFromClaims({ email: user['email'], name: typeof name === 'string' ? name : '', emailVerified: user['verifiedEmail'] === true, picture: user['picture'] });
      return p === undefined ? fail('invalid') : { kind: 'ok', profile: p };
    } catch (e) {
      return fail(e instanceof SyntaxError ? 'invalid' : reasonOf(e));
    }
  }

  return { verify, profile, close: () => undefined };
}
