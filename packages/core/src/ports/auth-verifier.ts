export interface Profile {
  readonly email: string;
  readonly name: string;
  readonly emailVerified: boolean;
  readonly avatarUrl?: string;
}

/**
 * What a verified token says about the person's tenant (docs/tenancy.md): `one` with its id, `none` (no usable tenant), or `many` (more than one, which the first version refuses).
 * A verifier that knows nothing of tenants leaves it out.
 */
export type TenantClaim = { readonly kind: 'one'; readonly id: string } | { readonly kind: 'none' } | { readonly kind: 'many' };

/** userId is the signed subject; expiresAt is milliseconds. A token profile and tenant come from trusted signed claims. */
export type VerifyResult =
  | { kind: 'ok'; userId: string; expiresAt: number; profile?: Profile; tenant?: TenantClaim }
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
