import { createHash, timingSafeEqual } from 'node:crypto';
import type { Clock } from '@tektum/grimoire-core/ports/clock';
import type { Config } from '@tektum/grimoire-core/ports/config';
import type { AuthVerifier, ProfileResult, VerifyResult } from '@tektum/grimoire-core/ports/auth-verifier';
import type { DevRole, DevRoleSource } from '@tektum/grimoire-core/ports/dev-role';

export const DEV_TOKEN_TTL_MS = 3_600_000;
/** Whole-token length bound, checked before any parsing. */
const MAX_TOKEN_LENGTH = 256;
/** Grammar: dev:<secret>:<userId>:<role>[:<tenant>]; secret is 16-128 and userId 1-64 of [A-Za-z0-9_-]; role is exactly admin|member|viewer; the tenant is 1-64 of [a-z0-9_-] and is `legacy` when absent (docs/tenancy.md section 2.4). */
// Dev user ids are lowercase only: the dev email is `<id>@dev.invalid` and the users table compares emails case-insensitively, so ids that differ only by case would collide there.
const TOKEN = /^dev:([A-Za-z0-9_-]{16,128}):([a-z0-9_-]{1,64}):(admin|member|viewer)(?::([a-z0-9_-]{1,64}))?$/;
/** The tenant of a development token with no tenant part: the one the migration puts every existing row in. */
export const DEFAULT_DEV_TENANT = 'legacy';

/** Constant-time equality: both sides are hashed first so the comparison runs over equal lengths whatever the candidate is. */
const sameSecret = (a: string, b: string): boolean => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

function parse(token: unknown, secret: string): { userId: string; role: DevRole; tenant: string } | undefined {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) return undefined;
  const m = TOKEN.exec(token);
  if (m === null) return undefined;
  const given = m[1];
  const userId = m[2];
  const role = m[3];
  if (given === undefined || !sameSecret(given, secret)) return undefined;
  if (userId === undefined || (role !== 'admin' && role !== 'member' && role !== 'viewer')) return undefined;
  return { userId, role, tenant: m[4] ?? DEFAULT_DEV_TENANT };
}

export function createDevAuth(config: Config, clock: Clock): { verifier: AuthVerifier; roles: DevRoleSource } {
  if (!config.local) {
    throw new Error('The development auth adapter requires local mode (set GRIMOIRE_LOCAL=1); refusing to start.');
  }
  const secret = config.devTokenSecret;
  if (secret === undefined) throw new Error('The development auth adapter requires GRIMOIRE_DEV_TOKEN_SECRET; refusing to start.');
  const verifier: AuthVerifier = {
    verify(token: string): Promise<VerifyResult> {
      const p = parse(token, secret);
      if (p === undefined) return Promise.resolve({ kind: 'invalid-token' });
      return Promise.resolve({ kind: 'ok', userId: p.userId, expiresAt: clock.now() + DEV_TOKEN_TTL_MS, tenant: { kind: 'one', id: p.tenant } });
    },
    profile(userId): Promise<ProfileResult> {
      return Promise.resolve({ kind: 'ok', profile: { email: `${userId}@dev.invalid`, name: userId, emailVerified: true } });
    },
  };
  const roles: DevRoleSource = {
    devOnly: true,
    roleOf: (token: string) => parse(token, secret)?.role,
  };
  return { verifier, roles };
}
