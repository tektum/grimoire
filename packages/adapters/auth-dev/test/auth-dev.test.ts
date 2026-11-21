import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../../core/src/testing/fake-clock.js';
import { makeFakeConfig } from '../../../core/src/testing/fake-config.js';
import { createDevAuth } from '../src/index.js';

const clock = new FakeClock(1_000_000);
const SECRET = 'test-secret-0123456789abcdef';
const config = makeFakeConfig({ local: true, devTokenSecret: SECRET });
const { verifier, roles } = createDevAuth(config, clock);

describe('dev adapter valid tokens', () => {
  it.each([
    [`dev:${SECRET}:alice:admin`, 'alice', 'admin'],
    [`dev:${SECRET}:bob:member`, 'bob', 'member'],
    [`dev:${SECRET}:carol:viewer`, 'carol', 'viewer'],
  ])('%s', async (token, userId, role) => {
    expect(await verifier.verify(token)).toEqual({ kind: 'ok', userId, expiresAt: 1_000_000 + 3_600_000 });
    expect(roles.roleOf(token)).toBe(role);
    expect(roles.devOnly).toBe(true);
  });
  it('profiles a development user and leaves verify results unchanged', async () => {
    expect(await verifier.profile?.('alice')).toEqual({
      kind: 'ok', profile: { email: 'alice@dev.invalid', name: 'alice', emailVerified: true },
    });
    expect(await verifier.verify(`dev:${SECRET}:alice:admin`)).toEqual({ kind: 'ok', userId: 'alice', expiresAt: 1_000_000 + 3_600_000 });
  });
  it('accepts a 64-character user id and rejects 65', async () => {
    expect((await verifier.verify(`dev:${SECRET}:${'a'.repeat(64)}:admin`)).kind).toBe('ok');
    expect((await verifier.verify(`dev:${SECRET}:${'a'.repeat(65)}:admin`)).kind).toBe('invalid-token');
  });
  it('expiry follows the clock at verification time', async () => {
    const c = new FakeClock(5);
    const a = createDevAuth(config, c);
    c.advance(3_599_999);
    expect(await a.verifier.verify(`dev:${SECRET}:a:admin`)).toMatchObject({ expiresAt: 5 + 3_599_999 + 3_600_000 });
  });
});

describe('dev adapter malformed tokens', () => {
  const bad: [string, string][] = [
    ['empty', ''],
    ['wrong prefix', 'Bearer x'],
    ['wrong prefix 2', 'prod:a:admin'],
    ['prefix only', `dev:${SECRET}:`],
    ['missing role', `dev:${SECRET}:a`],
    ['empty user', `dev:${SECRET}::admin`],
    ['empty role', `dev:${SECRET}:a:`],
    ['extra part', `dev:${SECRET}:a:admin:x`],
    ['unknown role', `dev:${SECRET}:bob:owner`],
    ['role upper case', `dev:${SECRET}:bob:Admin`],
    ['prefix upper case', 'DEV:bob:admin'],
    ['leading space', ' dev:bob:admin'],
    ['trailing space', `dev:${SECRET}:bob:admin `],
    ['trailing newline', `dev:${SECRET}:bob:admin\n`],
    ['embedded newline', `dev:${SECRET}:bo\nb:admin`],
    ['NUL', `dev:${SECRET}:bob\u0000:admin`],
    ['10,000 chars', `dev:${SECRET}:` + 'a'.repeat(10_000) + ':admin'],
    ['cyrillic look-alike', `dev:${SECRET}:b\u043eb:admin`],
    ['fullwidth colon', `dev:${SECRET}:bob\uff1aadmin`],
    ['path', `dev:${SECRET}:../etc/passwd:admin`],
    ['slash', `dev:${SECRET}:a/b:admin`],
    ['sql', `dev:${SECRET}:a' OR '1'='1:admin`],
    ['semicolon', `dev:${SECRET}:a;drop:admin`],
    ['dot', `dev:${SECRET}:a.b:admin`],
  ];
  it.each(bad)('%s -> invalid-token', async (_n, token) => {
    expect(await verifier.verify(token)).toEqual({ kind: 'invalid-token' });
    expect(roles.roleOf(token)).toBeUndefined();
  });
  it('never throws on non-string input', async () => {
    expect(await verifier.verify(undefined as unknown as string)).toEqual({ kind: 'invalid-token' });
    expect(await verifier.verify(null as unknown as string)).toEqual({ kind: 'invalid-token' });
  });
  it('user ids that differ only by case cannot exist: uppercase ids are refused (the users table compares emails case-insensitively)', async () => {
    expect(await verifier.verify(`dev:${SECRET}:Alice:admin`)).toEqual({ kind: 'invalid-token' });
    expect(await verifier.verify(`dev:${SECRET}:alice:admin`)).toMatchObject({ userId: 'alice' });
  });
});

describe('the token carries the secret (F2)', () => {
  const bad: [string, string][] = [
    ['no secret (the old grammar)', 'dev:alice:admin'],
    ['wrong secret', 'dev:wrong-secret-0123456789abc:alice:admin'],
    ['secret a prefix of the real one', `dev:${SECRET.slice(0, 20)}:alice:admin`],
    ['secret with a suffix', `dev:${SECRET}x:alice:admin`],
    ['secret upper-cased', `dev:${SECRET.toUpperCase()}:alice:admin`],
    ['secret in the user position', `dev:alice:${SECRET}:admin`],
  ];
  it.each(bad)('%s -> invalid-token', async (_n, token) => {
    expect(await verifier.verify(token)).toEqual({ kind: 'invalid-token' });
    expect(roles.roleOf(token)).toBeUndefined();
  });
  it('refuses to be built without a secret, with a message that names the setting', () => {
    expect(() => createDevAuth(makeFakeConfig({ local: true }), clock)).toThrow(/GRIMOIRE_DEV_TOKEN_SECRET/);
  });
});

describe('composition guard', () => {
  it('throws mentioning GRIMOIRE_LOCAL when not local', () => {
    expect(() => createDevAuth(makeFakeConfig({ local: false, devTokenSecret: SECRET }), clock)).toThrow(/GRIMOIRE_LOCAL/);
  });
});
