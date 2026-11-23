import type { AuthVerifier, Profile } from '../ports/auth-verifier.js';
import type { Logger } from '../ports/logger.js';
import type { Role, UserRecord, UserStore } from '../ports/user-store.js';

export interface SignInPolicy {
  readonly firstAdminEmails: readonly string[];
  readonly allowedEmailDomains: readonly string[];
  readonly allowDevRole: boolean;
}

/**
 * Provisioning success is NOT session authorization: an existing suspended user remains `ok`
 * carrying `user.suspended: true`. The caller MUST refuse session access if that flag is true,
 * before granting any access. Suspension has no provisioning-refusal reason by contract.
 */
export type SignInResult = { kind: 'ok'; user: UserRecord; created: boolean }
  | { kind: 'refused'; reason: 'domain-not-allowed' | 'email-taken' | 'profile-unavailable' | 'profile-missing' };

type NewUserInput = { descopeUserId: string; email: string; name: string; avatarUrl?: string; role: Role };
/** Admin is decided only for the full, verified email address, never a suffix or substring. */
const firstAdmin = (email: string, profile: Profile, policy: SignInPolicy): Role =>
  profile.emailVerified && policy.firstAdminEmails.some((a) => a.toLowerCase() === email) ? 'admin' : 'member';

// The config port validates first-admin addresses, but profile data is an input boundary too. Match its ASCII email
// expectations and reject quoted local parts, IP literals and malformed labels rather than storing arbitrary addresses.
const ADDRESS = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const emailDomain = (email: string): string | undefined => {
  // A single @ is stricter than merely splitting at the last @: it prevents treating a malformed second local part as a domain.
  if (email.length > 320 || !ADDRESS.test(email)) return undefined;
  return email.slice(email.lastIndexOf('@') + 1).toLowerCase();
};

/** An avatar is stored only as an https URL without credentials and within the length the identity-provider adapter already applies (2048); anything else is dropped and sign-in continues. */
const MAX_AVATAR_URL_CHARS = 2048;
function validAvatarUrl(value: string | undefined): value is string {
  if (value === undefined || value.length > MAX_AVATAR_URL_CHARS || !URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === 'https:' && url.username === '' && url.password === '';
}

function newCredentials(profile: Profile, policy: SignInPolicy): { email: string; domain: string } | undefined {
  const domain = emailDomain(profile.email); // the ASCII check runs on the address as it is stored, before any lowercasing
  const email = profile.email.toLowerCase();
  if (domain === undefined) return undefined;
  if (policy.allowedEmailDomains.length === 0) return policy.allowDevRole ? { email, domain } : undefined;
  if (!profile.emailVerified || !policy.allowedEmailDomains.some((d) => d.toLowerCase() === domain)) return undefined;
  return { email, domain };
}

/**
 * Creates users only from verified identity-provider data; sign-in never accepts credentials locally. A returning user is re-checked
 * against the allowed domains on every sign-in when the claims carry a profile.
 */
export function createProvisioner(d: { users: UserStore; verifier: AuthVerifier; policy: SignInPolicy; logger?: Logger }): {
  signIn(i: { identity: { userId: string; profile?: Profile }; devRole?: Role }): Promise<SignInResult>;
  /** The returning-user rule alone, for a row the caller has already read: it never reads, creates or changes a user. */
  recheck(i: { identity: { userId: string; profile?: Profile }; user: UserRecord }): SignInResult;
} {
  const refuse = (reason: Extract<SignInResult, { kind: 'refused' }>['reason']): SignInResult => {
    d.logger?.warn('users.refused', { reason });
    return { kind: 'refused', reason };
  };

  /** The stored address decides, as at every sign-in: its domain must still be allowed. */
  const storedDomainAllowed = (user: UserRecord): boolean => {
    const domain = emailDomain(user.email.toLowerCase());
    const domains = d.policy.allowedEmailDomains;
    return domain !== undefined && (domains.length === 0 ? d.policy.allowDevRole : domains.some((a) => a.toLowerCase() === domain));
  };

  return {
    recheck(i) {
      if (i.identity.userId === 'system:migration') return refuse('domain-not-allowed');
      if (i.identity.profile && !newCredentials(i.identity.profile, d.policy)) return refuse('domain-not-allowed');
      return storedDomainAllowed(i.user) ? { kind: 'ok', user: i.user, created: false } : refuse('domain-not-allowed');
    },
    /** `ok` is not authorization: callers MUST deny a session when the returned user is suspended. */
    async signIn(i) {
      // Only fixed refusal strings cross the public API: no personal data or detailed IdP errors.
      const finishExisting = async (user: UserRecord): Promise<SignInResult> => {
        if (!storedDomainAllowed(user)) return refuse('domain-not-allowed');
        // Domain eligibility never changes a stored role. Explicit devRole is the sole local-mode role update, section 4.
        if (d.policy.allowDevRole && i.devRole !== undefined && i.devRole !== user.role) {
          const updated = await d.users.updateRole(user.id, i.devRole);
          return updated ? { kind: 'ok', user: updated, created: false } : refuse('profile-unavailable');
        }
        return { kind: 'ok', user, created: false };
      };
      if (i.identity.userId === 'system:migration') return refuse('domain-not-allowed');
      const existing = await d.users.findByDescopeId(i.identity.userId);
      if (existing) {
        // A returning user is re-checked on every sign-in when the claims carry a profile (no extra fetch): the same checks as at
        // creation, the same refusal, and the stored row is not touched. Without a profile the stored email decides, as before.
        if (i.identity.profile && !newCredentials(i.identity.profile, d.policy)) return refuse('domain-not-allowed');
        return finishExisting(existing);
      }
      // Claims come first. The profile lookup is only required by an as-yet-unknown identity, for domains all sign-ins
      // in production need; refusing an empty production list avoids a needless management call.
      if (!i.identity.profile && d.policy.allowedEmailDomains.length === 0 && !d.policy.allowDevRole) return refuse('domain-not-allowed');
      let profile = i.identity.profile;
      if (!profile) {
        if (!d.verifier.profile) return refuse('profile-missing');
        const fetched = await d.verifier.profile(i.identity.userId);
        if (fetched.kind === 'unavailable') return refuse('profile-unavailable');
        if (fetched.kind === 'not-configured') return refuse('profile-missing');
        profile = fetched.profile;
      }
      const allowed = newCredentials(profile, d.policy);
      if (!allowed) return refuse('domain-not-allowed');
      const role = d.policy.allowDevRole && i.devRole ? i.devRole : firstAdmin(allowed.email, profile, d.policy);
      const input: NewUserInput = { descopeUserId: i.identity.userId, email: profile.email, name: profile.name, ...(validAvatarUrl(profile.avatarUrl) ? { avatarUrl: profile.avatarUrl } : {}), role };
      const result = await d.users.createIfAbsent(input);
      if (result.kind === 'email-taken') return refuse('email-taken');
      // A race winner created one row only, but any losing local-dev sign-in still synchronizes its own explicit role.
      if (result.kind === 'existing') return finishExisting(result.user);
      d.logger?.info('users.created', { userId: result.user.id, role: result.user.role });
      return { kind: 'ok', user: result.user, created: true };
    },
  };
}
