import { describe, expect, it } from 'vitest';
import { FakeAuthVerifier } from '@tektum/grimoire-adapter-auth-fake';
import type { AuthVerifier, Profile } from '../../src/ports/auth-verifier.js';
import type { Role, UserRecord, UserStore } from '../../src/ports/user-store.js';
import { FakeClock } from '../../src/testing/fake-clock.js';
import { FakeLogger } from '../../src/testing/fake-logger.js';
import { FakeUserStore } from '../../src/testing/fake-user-store.js';
import { createProvisioner, type SignInPolicy } from '../../src/users/provisioner.js';

const LOCAL: SignInPolicy = { firstAdminEmails: [], allowedEmailDomains: [], allowDevRole: true };
const PRODUCTION: SignInPolicy = { firstAdminEmails: [], allowedEmailDomains: ['example.test'], allowDevRole: false };
const profile = (email = 'person@example.test', emailVerified = true): Profile => ({ email, name: 'Private Person', emailVerified });

function fixture(policy: Partial<SignInPolicy> = {}, users = new FakeUserStore(), logger = new FakeLogger()) {
  const verifier = new FakeAuthVerifier(new FakeClock());
  const provisioner = createProvisioner({ users, verifier, policy: { ...PRODUCTION, ...policy }, logger });
  return { users, verifier, provisioner, logger };
}

/** Verified identity profiles are trusted auth output at the provisioner boundary, not external data for JWT parsing. */
let userCount = 0;
const identity = (value?: Profile, userId = `subject-${++userCount}`) => ({ userId, ...(value ? { profile: value } : {}) });

describe('FakeUserStore', () => {
  it('creates a default unsuspended record with stable random id and all port fields including optional avatar', async () => {
    const users = new FakeUserStore();
    const input = { descopeUserId: 'Subject', email: 'person@example.test', name: 'Person', avatarUrl: 'https://example.test/avatar', role: 'member' as Role };
    const created = await users.createIfAbsent(input);
    expect(created).toMatchObject({ kind: 'created', user: { ...input, suspended: false } });
    if (created.kind !== 'created') throw new Error('creation should succeed');
    expect(created.user.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await users.findByDescopeId('Subject')).toEqual(created.user);
    expect(await users.findByDescopeId('subject')).toBeUndefined();
    expect(users.all()).toEqual([created.user]);
    expect(await users.createIfAbsent({ ...input, role: 'admin' })).toEqual({ kind: 'existing', user: created.user });
  });

  it('models citext email uniqueness and separate subject identities', async () => {
    const users: UserStore = new FakeUserStore();
    const first = { descopeUserId: 'subject1', email: 'person@example.test', name: 'First', role: 'member' as const };
    await users.createIfAbsent(first);
    const next = await users.createIfAbsent({ ...first, descopeUserId: 'subject2', email: 'PERSON@example.TEST', name: 'Second', role: 'admin' });
    expect(next).toEqual({ kind: 'email-taken' });
    const third = await users.createIfAbsent({ descopeUserId: 'subject3', email: 'third@example.test', name: 'Third', role: 'viewer' });
    expect(third).toMatchObject({ kind: 'created' });
  });

  it('updateRole and suspend change their independent attributes and an unknown id has no update', async () => {
    const initial: UserRecord = { id: 'suspended-id', descopeUserId: 'subject', email: 's@example.test', name: 'Suspended', role: 'member', suspended: true };
    const users = new FakeUserStore([initial]);
    expect(users.suspend('subject')).toBe(true);
    expect(users.suspend('unknown')).toBe(false);
    expect(await users.updateRole('suspended-id', 'viewer')).toMatchObject({ role: 'viewer', suspended: true });
    expect(await users.updateRole('unknown', 'admin')).toBeUndefined();
    expect(await users.createIfAbsent({ descopeUserId: 'new', email: 'new@example.test', name: 'New', role: 'member' })).toMatchObject({ kind: 'created', user: { suspended: false } });
  });

  it('twenty simultaneous FakeUserStore createIfAbsent calls return exactly one created and nineteen existing', async () => {
    const users = new FakeUserStore();
    const input = { descopeUserId: 'same', email: 'same@example.test', name: 'Same', role: 'member' as const };
    const all = await Promise.all(Array.from({ length: 20 }, async () => users.createIfAbsent(input)));
    expect(all.filter((r) => r.kind === 'created')).toHaveLength(1);
    expect(all.filter((r) => r.kind === 'existing')).toHaveLength(19);
    expect(users.all()).toHaveLength(1);
  });
});

describe('sign-in provisioning', () => {
  it('with FakeUserStore and FakeAuthVerifier, first sign-in creates a member from verified management profile', async () => {
    const users = new FakeUserStore();
    const verifier = new FakeAuthVerifier(new FakeClock()).profileFor('new', { kind: 'ok', profile: profile() });
    const provisioner = createProvisioner({ users, verifier, policy: PRODUCTION, logger: new FakeLogger() });
    expect(await provisioner.signIn({ identity: { userId: 'new' } })).toMatchObject({ kind: 'ok', created: true, user: { descopeUserId: 'new', role: 'member', suspended: false } });
  });

  it('verified firstAdminEmails whole-address comparison ignoring case creates an admin', async () => {
    const { provisioner } = fixture({ firstAdminEmails: ['OWNER@EXAMPLE.TEST'] });
    expect(await provisioner.signIn({ identity: identity(profile('owner@example.test')) })).toMatchObject({ kind: 'ok', created: true, user: { role: 'admin' } });
  });

  it('listed but unverified email creates a member in empty-domain local mode and never admin', async () => {
    const { users, provisioner } = fixture({ ...LOCAL, firstAdminEmails: ['OWNER@EXAMPLE.TEST'] });
    expect(await provisioner.signIn({ identity: identity(profile('owner@example.test', false)) })).toMatchObject({ kind: 'ok', created: true, user: { role: 'member' } });
    expect(users.all()).toHaveLength(1);
  });

  it.each([
    { later: [] as readonly string[], initial: ['person@example.test'] as readonly string[], role: 'admin' as Role },
    { later: ['person@example.test'] as readonly string[], initial: [] as readonly string[], role: 'member' as Role },
  ])('second sign-in never changes role when firstAdminEmails changes from $initial to $later', async ({ initial, later, role }) => {
    const { users, verifier, provisioner } = fixture({ firstAdminEmails: initial });
    const subject = identity(profile(), 'stable');
    await provisioner.signIn({ identity: subject });
    const changed = createProvisioner({ users, verifier, policy: { ...PRODUCTION, firstAdminEmails: later } });
    expect(await changed.signIn({ identity: subject })).toMatchObject({ kind: 'ok', created: false, user: { role } });
  });

  it('domain suffix look-alike a@notallowed.com is refused when allowed.com is allowed', async () => {
    const { provisioner, users } = fixture({ allowedEmailDomains: ['allowed.com'] });
    expect(await provisioner.signIn({ identity: identity(profile('a@notallowed.com')) })).toEqual({ kind: 'refused', reason: 'domain-not-allowed' });
    expect(users.all()).toHaveLength(0);
  });

  it('a subdomain a@sub.allowed.com is not the same allowed domain', async () => {
    const { provisioner } = fixture({ allowedEmailDomains: ['allowed.com'] });
    expect(await provisioner.signIn({ identity: identity(profile('a@sub.allowed.com')) })).toEqual({ kind: 'refused', reason: 'domain-not-allowed' });
  });

  it('a@evil.com@allowed.com has a second @ and is refused despite the allowed suffix', async () => {
    const { provisioner } = fixture({ allowedEmailDomains: ['allowed.com'] });
    expect(await provisioner.signIn({ identity: identity(profile('a@evil.com@allowed.com')) })).toEqual({ kind: 'refused', reason: 'domain-not-allowed' });
  });

  it('a@allowed.com@evil.com has a second @ and cannot smuggle an allowed local string past the final domain', async () => {
    const { provisioner } = fixture({ allowedEmailDomains: ['allowed.com'] });
    expect(await provisioner.signIn({ identity: identity(profile('a@allowed.com@evil.com')) })).toEqual({ kind: 'refused', reason: 'domain-not-allowed' });
  });

  describe('returning users are re-checked when the claims carry a profile', () => {
    const signedUp = async (policy: Partial<SignInPolicy> = {}) => {
      const f = fixture({ allowedEmailDomains: ['example.test'], ...policy });
      const first = await f.provisioner.signIn({ identity: identity(profile('person@example.test'), 'returning-1') });
      expect(first).toMatchObject({ kind: 'ok', created: true });
      return { ...f, before: structuredClone(f.users.all()) };
    };
    it('an outside-domain email in the claims is refused with the new-user reason, and the stored row is unchanged', async () => {
      const f = await signedUp();
      expect(await f.provisioner.signIn({ identity: identity(profile('person@outside.test'), 'returning-1') })).toEqual({ kind: 'refused', reason: 'domain-not-allowed' });
      expect(f.users.all()).toEqual(f.before);
    });
    it('claims with emailVerified false are refused', async () => {
      const f = await signedUp();
      expect(await f.provisioner.signIn({ identity: identity(profile('person@example.test', false), 'returning-1') })).toEqual({ kind: 'refused', reason: 'domain-not-allowed' });
      expect(f.users.all()).toEqual(f.before);
    });
    it('a malformed email claim is refused (default deny)', async () => {
      const f = await signedUp();
      for (const bad of ['not-an-email', 'a@b@example.test', 'a@\u212Aexample.test']) {
        expect(await f.provisioner.signIn({ identity: identity(profile(bad), 'returning-1') }), bad).toEqual({ kind: 'refused', reason: 'domain-not-allowed' });
      }
      expect(f.users.all()).toEqual(f.before);
    });
    it('claims with no profile still sign the user in on the stored email, with no profile fetch', async () => {
      const f = await signedUp();
      expect(await f.provisioner.signIn({ identity: identity(undefined, 'returning-1') })).toMatchObject({ kind: 'ok', created: false });
    });
    it('a returning user whose claims pass the checks signs in, and the stored email is not replaced by the claim email', async () => {
      const f = await signedUp();
      const again = await f.provisioner.signIn({ identity: identity(profile('PERSON@example.test'), 'returning-1') });
      expect(again).toMatchObject({ kind: 'ok', created: false });
      expect(f.users.all()).toEqual(f.before);
    });
  });

  describe('the avatar URL is validated before it is stored', () => {
    const create = async (avatarUrl: string) => {
      const { provisioner, users } = fixture();
      const result = await provisioner.signIn({ identity: identity({ ...profile(), avatarUrl }) });
      expect(result).toMatchObject({ kind: 'ok', created: true });
      return users.all()[0];
    };
    it.each([
      ['http', 'http://example.test/a.png'],
      ['javascript:', 'javascript:alert(1)'],
      ['credentials in the URL', 'https://user:pw@example.test/a.png'],
      ['over-long', `https://example.test/${'a'.repeat(2100)}`],
      ['not a URL', 'https://'],
    ])('%s is not stored, and the sign-in continues', async (_n, url) => {
      expect((await create(url))?.avatarUrl).toBeUndefined();
    });
    it('a good https URL is stored', async () => {
      expect((await create('https://example.test/a.png'))?.avatarUrl).toBe('https://example.test/a.png');
    });
  });

  it('checks the address as stored: a non-ASCII character that lowercases to ASCII is refused (Kelvin sign)', async () => {
    const { provisioner, users } = fixture({ allowedEmailDomains: ['kexample.test'] });
    expect(await provisioner.signIn({ identity: identity(profile('a@\u212Aexample.test')) })).toEqual({ kind: 'refused', reason: 'domain-not-allowed' });
    expect(users.all()).toEqual([]);
  });

  it('a trailing domain dot does not authorize a@allowed.com. for allowed.com', async () => {
    const { provisioner } = fixture({ allowedEmailDomains: ['allowed.com'] });
    expect(await provisioner.signIn({ identity: identity(profile('a@allowed.com.')) })).toEqual({ kind: 'refused', reason: 'domain-not-allowed' });
  });

  it('different-top-level look-alike a@allowed.com.evil.com is refused', async () => {
    const { provisioner } = fixture({ allowedEmailDomains: ['allowed.com'] });
    expect(await provisioner.signIn({ identity: identity(profile('a@allowed.com.evil.com')) })).toEqual({ kind: 'refused', reason: 'domain-not-allowed' });
  });

  it('mixed case allowed domain and address are accepted as a full-address case-insensitive match', async () => {
    const { provisioner } = fixture({ allowedEmailDomains: ['AlLoWeD.CoM'] });
    expect(await provisioner.signIn({ identity: identity(profile('Person@aLlOwEd.cOm')) })).toMatchObject({ kind: 'ok', created: true });
  });

  it('internationalised look-alike a@allöwed.com is not a normalized form of allowed.com', async () => {
    const { provisioner } = fixture({ allowedEmailDomains: ['allowed.com'] });
    expect(await provisioner.signIn({ identity: identity(profile('a@allöwed.com')) })).toEqual({ kind: 'refused', reason: 'domain-not-allowed' });
  });

  it('first-admin owner@allowed.com look-alike owner@notallowed.com never becomes admin', async () => {
    const { provisioner } = fixture({ allowedEmailDomains: ['allowed.com'], firstAdminEmails: ['owner@allowed.com'] });
    expect(await provisioner.signIn({ identity: identity(profile('owner@notallowed.com')) })).toEqual({ kind: 'refused', reason: 'domain-not-allowed' });
  });

  it('first-admin owner@allowed.com tagged owner+tag@allowed.com never becomes admin', async () => {
    const { provisioner } = fixture({ allowedEmailDomains: ['allowed.com'], firstAdminEmails: ['owner@allowed.com'] });
    expect(await provisioner.signIn({ identity: identity(profile('owner+tag@allowed.com')) })).toMatchObject({ kind: 'ok', user: { role: 'member' } });
  });

  it('a longer valid verified address containing an entire firstAdminEmails entry is never admin', async () => {
    const { provisioner } = fixture({ ...LOCAL, firstAdminEmails: ['owner@allowed.com'] });
    expect(await provisioner.signIn({ identity: identity(profile('xowner@allowed.com')) })).toMatchObject({ kind: 'ok', user: { role: 'member' } });
  });

  it('an existing user whose stored address merely ends in the current allowed suffix is refused', async () => {
    const previous: UserRecord = { id: 'lookalike-existing', descopeUserId: 'lookalike-existing', email: 'subject@notallowed.com', name: 'Previous', role: 'admin', suspended: false };
    const { provisioner } = fixture({ allowedEmailDomains: ['allowed.com'] }, new FakeUserStore([previous]));
    expect(await provisioner.signIn({ identity: { userId: previous.descopeUserId } })).toEqual({ kind: 'refused', reason: 'domain-not-allowed' });
  });

  it('new and existing users outside allowed domains are each refused by signIn', async () => {
    const { users, provisioner } = fixture({ allowedEmailDomains: ['allowed.test'] });
    await provisioner.signIn({ identity: identity(profile('PERSON@ALLOWED.TEST'), 'existing') });
    expect(await provisioner.signIn({ identity: identity(profile('new@outside.test')) })).toEqual({ kind: 'refused', reason: 'domain-not-allowed' });
    const changed = createProvisioner({ users, verifier: new FakeAuthVerifier(new FakeClock()), policy: { ...PRODUCTION, allowedEmailDomains: ['other.test'] } });
    expect(await changed.signIn({ identity: { userId: 'existing' } })).toEqual({ kind: 'refused', reason: 'domain-not-allowed' });
    expect(users.all()).toHaveLength(1);
  });

  it('empty list allows any domain only when allowDevRole is true and refuses everything false', async () => {
    const local = fixture(LOCAL);
    expect(await local.provisioner.signIn({ identity: identity(profile('person@other-domain.test')) })).toMatchObject({ kind: 'ok' });
    const production = fixture({ allowedEmailDomains: [] });
    expect(await production.provisioner.signIn({ identity: identity(profile()) })).toEqual({ kind: 'refused', reason: 'domain-not-allowed' });
    expect(production.users.all()).toHaveLength(0);
  });

  it('an unverified email is refused with a non-empty domain list and never first-admin', async () => {
    const { users, provisioner } = fixture({ firstAdminEmails: ['person@example.test'] });
    expect(await provisioner.signIn({ identity: identity(profile('PERSON@example.TEST', false)) })).toEqual({ kind: 'refused', reason: 'domain-not-allowed' });
    expect(users.all()).toHaveLength(0);
  });

  it('claims in identity prevent profile unavailable from being requested', async () => {
    const { users, verifier } = fixture();
    const subject = identity(profile('claims@example.test'));
    const calls: string[] = [];
    const tracked: AuthVerifier = { verify: (token) => verifier.verify(token), profile: async (userId) => { calls.push(userId); return verifier.profile(userId); } };
    const provisioner = createProvisioner({ users, verifier: tracked, policy: PRODUCTION });
    verifier.profileFor(subject.userId, { kind: 'unavailable' });
    expect(await provisioner.signIn({ identity: subject })).toMatchObject({ kind: 'ok', created: true });
    expect(users.all()).toMatchObject([{ email: 'claims@example.test' }]);
    expect(calls).toEqual([]);
  });

  it('FakeAuthVerifier profile unavailable gives profile-unavailable and no row', async () => {
    const users = new FakeUserStore();
    const verifier = new FakeAuthVerifier(new FakeClock()).profileFor('new', { kind: 'unavailable' });
    const provisioner = createProvisioner({ users, verifier, policy: PRODUCTION });
    expect(await provisioner.signIn({ identity: { userId: 'new' } })).toEqual({ kind: 'refused', reason: 'profile-unavailable' });
    expect(users.all()).toHaveLength(0);
  });

  it('FakeAuthVerifier not-configured and no claims gives profile-missing and no row', async () => {
    const users = new FakeUserStore();
    const provisioner = createProvisioner({ users, verifier: new FakeAuthVerifier(new FakeClock()), policy: PRODUCTION });
    expect(await provisioner.signIn({ identity: { userId: 'new' } })).toEqual({ kind: 'refused', reason: 'profile-missing' });
    expect(users.all()).toHaveLength(0);
  });

  it('no optional profile method means profile-missing without a row', async () => {
    const users = new FakeUserStore();
    const verifier: AuthVerifier = { verify: (token) => { void token; return Promise.resolve({ kind: 'invalid-token' }); } };
    const provisioner = createProvisioner({ users, verifier, policy: LOCAL });
    expect(await provisioner.signIn({ identity: identity() })).toEqual({ kind: 'refused', reason: 'profile-missing' });
    expect(users.all()).toHaveLength(0);
  });

  it('an email held by another sub gives fixed email-taken and only the original row', async () => {
    const { users, provisioner } = fixture(LOCAL);
    await provisioner.signIn({ identity: identity(profile(), 'first') });
    expect(await provisioner.signIn({ identity: identity(profile('PERSON@example.TEST'), 'second') })).toEqual({ kind: 'refused', reason: 'email-taken' });
    expect(users.all()).toHaveLength(1);
  });

  it('suspended existing user is returned without lifting suspension', async () => {
    const existing: UserRecord = { id: 'suspended-id', descopeUserId: 'suspended', email: 's@example.test', name: 'Suspended', role: 'admin', suspended: true };
    const { provisioner } = fixture(PRODUCTION, new FakeUserStore([existing]));
    expect(await provisioner.signIn({ identity: { userId: 'suspended' } })).toEqual({ kind: 'ok', created: false, user: existing });
  });

  it('a same-subject winner row accepts the losing request devRole only in local mode', async () => {
    const winner: UserRecord = { id: 'winner-id', descopeUserId: 'same-sub', email: 'dev@example.test', name: 'Dev', role: 'member', suspended: true };
    const updates: Role[] = [];
    const store: UserStore = {
      findByDescopeId: () => Promise.resolve(undefined),
      createIfAbsent: () => Promise.resolve({ kind: 'existing', user: winner }),
      updateRole: (_, role) => { updates.push(role); return Promise.resolve({ ...winner, role }); },
    };
    const request = { identity: { userId: 'same-sub', profile: profile('dev@example.test') }, devRole: 'admin' as Role };
    const local = createProvisioner({ users: store, verifier: new FakeAuthVerifier(new FakeClock()), policy: LOCAL });
    expect(await local.signIn(request)).toMatchObject({ kind: 'ok', created: false, user: { role: 'admin', suspended: true } });
    expect(updates).toEqual(['admin']);
    const production = createProvisioner({ users: store, verifier: new FakeAuthVerifier(new FakeClock()), policy: { ...LOCAL, allowedEmailDomains: ['example.test'], allowDevRole: false } });
    expect(await production.signIn(request)).toMatchObject({ kind: 'ok', created: false, user: { role: 'member' } });
  });

  it('devRole is applied only allowDevRole true and ignored on creation and repeat when false', async () => {
    const local = fixture(LOCAL);
    const dev = identity(profile(), 'dev');
    expect(await local.provisioner.signIn({ identity: dev, devRole: 'viewer' })).toMatchObject({ kind: 'ok', created: true, user: { role: 'viewer' } });
    expect(await local.provisioner.signIn({ identity: dev, devRole: 'admin' })).toMatchObject({ kind: 'ok', created: false, user: { role: 'admin' } });
    expect(await local.provisioner.signIn({ identity: dev })).toMatchObject({ kind: 'ok', user: { role: 'admin' } });
    const production = fixture(PRODUCTION);
    const normal = identity(profile(), 'normal');
    expect(await production.provisioner.signIn({ identity: normal, devRole: 'admin' })).toMatchObject({ kind: 'ok', user: { role: 'member' } });
    expect(await production.provisioner.signIn({ identity: normal, devRole: 'admin' })).toMatchObject({ kind: 'ok', user: { role: 'member' } });
  });

  it.each(['no-at.example.test', '@example.test', 'local@empty@example.test'])('malformed email %s uses last-at extraction and is rejected', async (email) => {
    const { users, provisioner } = fixture(LOCAL);
    expect(await provisioner.signIn({ identity: identity(profile(email)) })).toEqual({ kind: 'refused', reason: 'domain-not-allowed' });
    expect(users.all()).toHaveLength(0);
  });

  it('SignInResult suspended ok requires the caller to refuse a session before any authorization is granted', async () => {
    const { users } = fixture(PRODUCTION, new FakeUserStore([{ id: 'suspended-id', descopeUserId: 'suspended', email: 's@example.test', name: 'S', role: 'admin', suspended: true }]));
    const verifier = new FakeAuthVerifier(new FakeClock());
    const provisioner = createProvisioner({ users, verifier, policy: PRODUCTION });
    const result = await provisioner.signIn({ identity: { userId: 'suspended' } });
    if (result.kind !== 'ok') throw new Error('existing allowed-domain user expected');
    expect(result.user.suspended).toBe(true);
    // The application-caller obligation intentionally belongs here, NOT in SignInResult: suspension is not a provisioning refusal.
    const authorized = result.kind === 'ok' && !result.user.suspended;
    expect(authorized).toBe(false);
  });

  it('system:migration is never signed in with claims or a development role', async () => {
    const system: UserRecord = { id: '00000000-0000-4000-8000-000000000001', descopeUserId: 'system:migration', email: 'system@dev.invalid', name: 'System', role: 'viewer', suspended: true };
    const { users, provisioner } = fixture(LOCAL, new FakeUserStore([system]));
    expect(await provisioner.signIn({ identity: { userId: 'system:migration', profile: profile('system@grimoire.invalid') }, devRole: 'admin' })).toEqual({ kind: 'refused', reason: 'domain-not-allowed' });
    expect(users.all()).toEqual([system]);
  });

  it('created and refusal logs contain no email or name and only exact id plus role or reason fields', async () => {
    const logger = new FakeLogger();
    const { provisioner, users } = fixture({ ...PRODUCTION, firstAdminEmails: ['private-secret@example.test'] }, new FakeUserStore(), logger);
    await provisioner.signIn({ identity: identity(profile('private-secret@example.test'), 'first') });
    await provisioner.signIn({ identity: identity(profile('other-secret@outside.test'), 'second') });
    expect(logger.entries).toContainEqual({ level: 'info', event: 'users.created', fields: { userId: users.all()[0]?.id, role: 'admin' } });
    expect(logger.entries).toContainEqual({ level: 'warn', event: 'users.refused', fields: { reason: 'domain-not-allowed' } });
    const output = JSON.stringify(logger.entries);
    expect(output).not.toContain('private-secret@example.test');
    expect(output).not.toContain('other-secret@outside.test');
    expect(output).not.toContain('Private Person');
    expect(output).not.toContain('private-signed-token');
  });
});

describe('recheck (the returning-user rule on a row already read)', () => {
  const stored = (email: string): UserRecord => ({ id: 'u1', descopeUserId: 's1', email, name: 'Person', role: 'member', suspended: false });

  it('accepts a stored address in an allowed domain, whatever its case, and changes nothing', async () => {
    const users = new FakeUserStore();
    const { provisioner } = fixture({}, users);
    const row = stored('Person@Example.TEST');
    expect(provisioner.recheck({ identity: identity(), user: row })).toEqual({ kind: 'ok', user: row, created: false });
    expect(users.all()).toEqual([]);
  });

  it('refuses a stored address whose domain is no longer allowed, and logs the refusal once', () => {
    const { provisioner, logger } = fixture();
    expect(provisioner.recheck({ identity: identity(), user: stored('person@removed.test') })).toEqual({ kind: 'refused', reason: 'domain-not-allowed' });
    expect(logger.entries.filter((e) => e.event === 'users.refused')).toHaveLength(1);
  });

  it('refuses when the claims carry a profile outside the allowed domains or unverified', () => {
    const { provisioner } = fixture();
    expect(provisioner.recheck({ identity: identity(profile('person@removed.test')), user: stored('person@example.test') }).kind).toBe('refused');
    expect(provisioner.recheck({ identity: identity(profile('person@example.test', false)), user: stored('person@example.test') }).kind).toBe('refused');
    expect(provisioner.recheck({ identity: identity(profile()), user: stored('person@example.test') }).kind).toBe('ok');
  });

  it('refuses the migration identity and a stored address that is not a valid address', () => {
    const { provisioner } = fixture();
    expect(provisioner.recheck({ identity: identity(undefined, 'system:migration'), user: stored('person@example.test') }).kind).toBe('refused');
    expect(provisioner.recheck({ identity: identity(), user: stored('not-an-address') }).kind).toBe('refused');
  });

  it('follows the local-mode rule when no domains are listed', () => {
    expect(fixture({ allowedEmailDomains: [], allowDevRole: true }).provisioner.recheck({ identity: identity(), user: stored('a@anywhere.test') }).kind).toBe('ok');
    expect(fixture({ allowedEmailDomains: [], allowDevRole: false }).provisioner.recheck({ identity: identity(), user: stored('a@anywhere.test') }).kind).toBe('refused');
  });
});
