export interface Profile {
  readonly email: string;
  readonly name: string;
  readonly emailVerified: boolean;
  readonly avatarUrl?: string;
}

/** userId is the signed subject; expiresAt is milliseconds. A token profile comes from trusted signed claims. */
export type VerifyResult =
  | { kind: 'ok'; userId: string; expiresAt: number; profile?: Profile }
  | { kind: 'invalid-token' }
  | { kind: 'service-unavailable' };

export type ProfileResult = { kind: 'ok'; profile: Profile } | { kind: 'unavailable' } | { kind: 'not-configured' };

export interface AuthVerifier {
  verify(token: string): Promise<VerifyResult>;
  /** Optional so implementers without a management profile source still compile. */
  profile?(userId: string): Promise<ProfileResult>;
}

/** The identity provider's project id: letters and digits only, 1 to 128 of them. The one rule, used by the configuration loader and by the verifier. */
export const isDescopeProjectId = (value: string): boolean => /^[A-Za-z0-9]{1,128}$/.test(value);
