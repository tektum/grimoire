import { createRemoteJWKSet, customFetch, errors, jwtVerify, type JWTVerifyOptions } from 'jose';
import type { Clock } from '@tektum/grimoire-core/ports/clock';
import type { Logger } from '@tektum/grimoire-core/ports/logger';
import { isDescopeProjectId, type AuthVerifier, type Profile, type ProfileResult, type VerifyResult } from '@tektum/grimoire-core/ports/auth-verifier';

export interface DescopeVerifierOptions {
  projectId: string;
  baseUrl?: string | undefined;
  managementKey?: string | undefined;
  logger: Logger;
  clock: Clock;
  /** Accepted `iss` values (exact match). Default: the project id [contracts section 3]. */
  issuers?: string[] | undefined;
  /** When set, `aud` must match exactly; default is no audience check (`aud` is absent by default). */
  audience?: string | undefined;
  fetchTimeoutMs?: number | undefined;
  cooldownMs?: number | undefined;
  reloadIntervalMs?: number | undefined;
  staleMaxAgeMs?: number | undefined;
  /** After a failed key fetch no new fetch is made for this long (bounds load on Descope while it is down). */
  failureBackoffMs?: number | undefined;
  /** Largest accepted remaining lifetime (exp - now). Default 24 h: conservative, Descope documents no session-token maximum. */
  maxTokenLifetimeMs?: number | undefined;
}

export type DescopeVerifier = AuthVerifier & { close(): void };

/** Whole-token length bound, checked before any parsing or network call (security review N2). */
const MAX_TOKEN_LENGTH = 8192;
/** A key set is a few hundred bytes per key; anything above this is refused unread. */
const MAX_KEYS_BYTES = 256 * 1024;
const MAX_PROFILE_BYTES = 64 * 1024;
const CLOCK_TOLERANCE_SECONDS = 5;
/** Documented session-token `drn` value (docs.descope.com/management/token: "typically DS"); the refresh value is not documented, so every other value is refused. */
const SESSION_DRN = 'DS';
/** sub: 1-256 characters, no control characters (C0, DEL, C1), no leading or trailing whitespace. Descope ids are short alphanumerics, so this is wider. */
const hasControl = (v: string): boolean => [...v].some((c) => { const n = c.codePointAt(0) ?? 0; return n <= 0x1f || (n >= 0x7f && n <= 0x9f); });
/** A key we can verify with: an RSA signing key for RS256 with a sound base64url modulus (at least 2048 bits) and exponent. */
const B64URL = /^[A-Za-z0-9_-]+$/;
function usableKey(k: unknown): boolean {
  if (!isRecord(k) || k['kty'] !== 'RSA') return false;
  if (k['alg'] !== undefined && k['alg'] !== 'RS256') return false;
  if (k['use'] !== undefined && k['use'] !== 'sig') return false;
  const { n, e } = k;
  return typeof n === 'string' && typeof e === 'string' && B64URL.test(n) && B64URL.test(e) && Buffer.from(n, 'base64url').byteLength >= 256;
}
const INVALID: VerifyResult = { kind: 'invalid-token' };
const UNAVAILABLE: VerifyResult = { kind: 'service-unavailable' };
/** jose errors that mean "could not get keys", not "bad token". */
const KEY_SERVICE_CODES = new Set(['ERR_JOSE_GENERIC', 'ERR_JWKS_TIMEOUT', 'ERR_JWKS_INVALID']);

type FailReason = 'timeout' | 'http' | 'invalid' | 'network';
class KeysInvalid extends Error {}
class KeysHttp extends Error {}
class KeysBackoff extends Error {}

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

/** Reads at most `max` bytes (hand-written: neither fetch nor jose bounds the body). */
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

/** Hand-written (the claim shape is ours, not jose's): signed top-level claims only; anything wrongly typed gives no profile. */
function profileFromClaims(p: Record<string, unknown>): Profile | undefined {
  const { email, name, emailVerified, picture } = p;
  if (typeof email !== 'string' || email === '' || email.length > 320) return undefined;
  if (typeof name !== 'string' || name.length > 200 || typeof emailVerified !== 'boolean') return undefined;
  const avatar = typeof picture === 'string' && picture.length <= 2048 && picture.startsWith('https://') ? { avatarUrl: picture } : {};
  return { email, name: name === '' ? email : name, emailVerified, ...avatar };
}

export function createDescopeVerifier(o: DescopeVerifierOptions): DescopeVerifier {
  if (typeof o.projectId !== 'string' || o.projectId === '') throw new Error('Descope project id is required');
  if (!isDescopeProjectId(o.projectId)) throw new Error('Descope project id must be alphanumeric');
  const { projectId, logger, clock } = o;
  const base = descopeBaseUrl(projectId, o.baseUrl);
  const fetchTimeoutMs = o.fetchTimeoutMs ?? 3000;
  const cooldownMs = o.cooldownMs ?? 30_000;
  const reloadIntervalMs = o.reloadIntervalMs ?? 600_000;
  const staleMaxAgeMs = o.staleMaxAgeMs ?? 3_600_000;
  const maxLifetimeMs = o.maxTokenLifetimeMs ?? 24 * 3_600_000;
  const failureBackoffMs = o.failureBackoffMs ?? 5000;
  const issuers = o.issuers !== undefined && o.issuers.length > 0 ? o.issuers : [projectId];
  const doFetch = globalThis.fetch.bind(globalThis);

  let lastGood: number | undefined;
  let blockedUntil = 0;
  let lastStaleLog = Number.NEGATIVE_INFINITY;

  const failed = (e: unknown): void => {
    blockedUntil = clock.now() + failureBackoffMs;
    logger.warn('auth.keys_reload_failed', { reason: reasonOf(e) });
  };

  /** Only the key-set address and jose's own options reach the network; jose supplies the timeout signal and `redirect: manual`. */
  const keyFetch: NonNullable<Parameters<typeof createRemoteJWKSet>[1]>[typeof customFetch] = async (url, init) => {
    if (clock.now() < blockedUntil) throw new KeysBackoff();
    try {
      const res = await doFetch(url, init);
      if (res.status !== 200) {
        await res.body?.cancel();
        throw new KeysHttp();
      }
      const text = await readBounded(res, MAX_KEYS_BYTES);
      const parsed: unknown = JSON.parse(text);
      if (!isRecord(parsed) || !Array.isArray(parsed['keys']) || !parsed['keys'].some(usableKey)) throw new KeysInvalid(); // a set without a usable key never replaces the cache nor counts as a good fetch
      lastGood = clock.now();
      blockedUntil = 0;
      return new Response(text, { status: 200, headers: { 'content-type': 'application/json' } });
    } catch (e) {
      failed(e instanceof SyntaxError ? new KeysInvalid() : e);
      throw e;
    }
  };

  const keys = createRemoteJWKSet(new URL(`${base}/v2/keys/${projectId}`), {
    timeoutDuration: fetchTimeoutMs,
    cooldownDuration: cooldownMs,
    cacheMaxAge: Infinity,
    [customFetch]: keyFetch,
  });

  /** One refresh at a time: concurrent callers await the same promise (one fetch, one backoff); it is cleared when it settles. */
  let inFlight: Promise<void> | undefined;
  const refresh = (): Promise<void> => {
    inFlight ??= (async () => {
      try { await keys.reload(); } catch { /* keyFetch has logged the reason; the cache is unchanged */ } finally { inFlight = undefined; }
    })();
    return inFlight;
  };
  const timer = setInterval(() => { void refresh(); }, reloadIntervalMs);
  timer.unref();

  const isStale = (): boolean => lastGood !== undefined && clock.now() - lastGood > staleMaxAgeMs;

  const verifyOptions: JWTVerifyOptions = { algorithms: ['RS256'], issuer: issuers, clockTolerance: CLOCK_TOLERANCE_SECONDS, requiredClaims: ['sub', 'exp', 'iat', 'iss'] };
  if (o.audience !== undefined) verifyOptions.audience = o.audience;

  async function verify(token: string): Promise<VerifyResult> {
    if (typeof token !== 'string' || token === '' || token.length > MAX_TOKEN_LENGTH) return INVALID;
    if (isStale()) await refresh();
    if (lastGood !== undefined && isStale()) {
      if (clock.now() - lastStaleLog >= cooldownMs) {
        lastStaleLog = clock.now();
        logger.error('auth.keys_stale', { ageSeconds: Math.floor((clock.now() - lastGood) / 1000) });
      }
      return UNAVAILABLE;
    }
    try {
      const now = clock.now();
      const { payload } = await jwtVerify(token, keys, { ...verifyOptions, currentDate: new Date(now) });
      const { sub, exp, iat, nbf, drn } = payload;
      if (drn !== SESSION_DRN) return INVALID;
      // jose checks exp and nbf but not iat, and only checks claim presence: types and a future iat are ours (hand-written).
      if (typeof sub !== 'string' || sub === '' || sub.length > 256 || hasControl(sub) || sub !== sub.trim()) return INVALID;
      if (!Number.isSafeInteger(exp) || !Number.isSafeInteger(iat) || (nbf !== undefined && !Number.isSafeInteger(nbf))) return INVALID;
      if (typeof exp !== 'number' || typeof iat !== 'number' || iat < 0 || (exp - iat) * 1000 > maxLifetimeMs || exp * 1000 - now > maxLifetimeMs) return INVALID; // issued lifetime and remaining lifetime are both bounded
      if (iat * 1000 > now + CLOCK_TOLERANCE_SECONDS * 1000) return INVALID;
      const profile = profileFromClaims(payload);
      return profile === undefined ? { kind: 'ok', userId: sub, expiresAt: exp * 1000 } : { kind: 'ok', userId: sub, expiresAt: exp * 1000, profile };
    } catch (e) {
      if (e instanceof errors.JOSEError) return KEY_SERVICE_CODES.has(e.code) ? UNAVAILABLE : INVALID;
      return UNAVAILABLE;
    }
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
      // Hand-written, without the provider's SDK (fewer dependencies in the trust path). Checked against the provider's Load User documentation
      // (http://docs.descope.com/api/management/users/load-user, 2026-11-21): GET /v1/mgmt/user, query parameter userId (or loginId),
      // `Authorization: Bearer <project id>:<management key>`, answer { user: { email, name, verifiedEmail, picture } }.
      const res = await fetch(`${base}/v1/mgmt/user?userId=${encodeURIComponent(userId)}`, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(fetchTimeoutMs),
        headers: { authorization: `Bearer ${projectId}:${managementKey}`, accept: 'application/json' },
      });
      if (res.status !== 200) {
        await res.body?.cancel();
        return fail('http');
      }
      const parsed: unknown = JSON.parse(await readBounded(res, MAX_PROFILE_BYTES));
      const user = isRecord(parsed) ? parsed['user'] : undefined;
      if (!isRecord(user) || typeof user['email'] !== 'string' || user['email'] === '' || user['email'].length > 320) return fail('invalid');
      const name = user['name'];
      const picture = user['picture'];
      const p = profileFromClaims({ email: user['email'], name: typeof name === 'string' ? name : '', emailVerified: user['verifiedEmail'] === true, picture });
      return p === undefined ? fail('invalid') : { kind: 'ok', profile: p };
    } catch (e) {
      return fail(e instanceof SyntaxError ? 'invalid' : reasonOf(e));
    }
  }

  return { verify, profile, close: () => { clearInterval(timer); } };
}
