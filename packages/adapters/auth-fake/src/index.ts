import type { Clock } from '@tektum/grimoire-core/ports/clock';
import type { AuthVerifier, ProfileResult, VerifyResult } from '@tektum/grimoire-core/ports/auth-verifier';

type Script =
  | { kind: 'ok'; userId: string; expiresAt: number; clockDriven: boolean }
  | { kind: 'invalid-token' }
  | { kind: 'service-unavailable' };

/** Scriptable verifier for other packages' tests. Unscripted tokens are invalid. */
export class FakeAuthVerifier implements AuthVerifier {
  private readonly scripts = new Map<string, Script>();
  private readonly profiles = new Map<string, ProfileResult>();
  private allUnavailable = false;

  constructor(private readonly clock: Clock) {}

  profileFor(userId: string, result: ProfileResult): this {
    this.profiles.set(userId, result);
    return this;
  }

  profile(userId: string): Promise<ProfileResult> {
    return Promise.resolve(this.profiles.get(userId) ?? { kind: 'not-configured' });
  }

  /** Token verifies as ok with exactly this expiresAt, even if already in the past (the caller judges expiry). */
  allow(token: string, userId: string, expiresAt = Number.MAX_SAFE_INTEGER): this {
    this.scripts.set(token, { kind: 'ok', userId, expiresAt, clockDriven: false });
    return this;
  }

  /** Token is ok while clock.now() < expiresAt; at or after it the token is invalid-token. */
  allowUntil(token: string, userId: string, expiresAt: number): this {
    this.scripts.set(token, { kind: 'ok', userId, expiresAt, clockDriven: true });
    return this;
  }

  reject(token: string): this {
    this.scripts.set(token, { kind: 'invalid-token' });
    return this;
  }

  /** One token, or (no argument) every token, fails with service-unavailable. */
  unavailable(token?: string): this {
    if (token === undefined) this.allUnavailable = true;
    else this.scripts.set(token, { kind: 'service-unavailable' });
    return this;
  }

  recover(): this {
    this.allUnavailable = false;
    return this;
  }

  verify(token: string): Promise<VerifyResult> {
    return Promise.resolve(this.resolve(token));
  }

  private resolve(token: string): VerifyResult {
    if (this.allUnavailable) return { kind: 'service-unavailable' };
    const s = this.scripts.get(token);
    if (s === undefined || s.kind === 'invalid-token') return { kind: 'invalid-token' };
    if (s.kind === 'service-unavailable') return s;
    if (s.clockDriven && this.clock.now() >= s.expiresAt) return { kind: 'invalid-token' };
    return { kind: 'ok', userId: s.userId, expiresAt: s.expiresAt };
  }
}
