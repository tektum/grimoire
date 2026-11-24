import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAuth } from '../../src/auth';
import { createDevSignIn, DEV_FORM_TEXTS, DEV_TOKEN_KEY, DEV_TOKEN_LIFE_MS, validateDevForm } from '../../src/auth/dev-signin';
import { createClientStorage } from '../../src/storage';
import { config, fakeSdkStorage, fakeStorage, spyConsole } from './support';

const SECRET = 'ab12'.repeat(8);
const PATTERN = /^dev:[A-Za-z0-9_-]{16,128}:[a-z0-9_-]{1,64}:(admin|member|viewer)$/;
let consoleSpy: ReturnType<typeof spyConsole> | undefined;
afterEach(() => consoleSpy?.restore());

const ok = () => vi.fn(async () => new Response('{}', { status: 200 }));

function form(fetchFn: typeof fetch, now = () => 1_000_000) {
  const { storage, map } = fakeStorage();
  return { devSignIn: createDevSignIn({ apiUrl: 'http://api.test', storage, now, fetch: fetchFn }), storage, map };
}

describe('the development sign-in form', () => {
  it('builds dev:<secret>:<userId>:<role> for each role, asks GET /v1/me with it, and stores it with its hour', async () => {
    for (const role of ['admin', 'member', 'viewer']) {
      const fetchFn = ok();
      const { devSignIn, storage, map } = form(fetchFn as never, () => 5000);
      expect(await devSignIn.signIn({ userId: 'alice', role, secret: SECRET })).toEqual({ ok: true });
      const token = storage.get(DEV_TOKEN_KEY)!;
      expect(token).toMatch(PATTERN);
      expect(token).toBe(`dev:${SECRET}:alice:${role}`);
      expect(token.length).toBeLessThanOrEqual(256);
      const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('http://api.test/v1/me');
      expect(init.headers).toEqual({ Authorization: `Bearer ${token}` });
      expect(init.credentials).toBe('omit');
      expect(devSignIn.read()).toEqual({ token, expiresAt: 5000 + DEV_TOKEN_LIFE_MS });
      expect([...map.keys()].sort()).toEqual(['grimoire.dev-token', 'grimoire.dev-token-expires']);
    }
  });

  it.each([['Alice'], ['ALICE'], ['a b'], ['a:b'], [''], ['é'], ['a'.repeat(65)]])('refuses the user id %j with the form text, before any request', async (userId) => {
    const fetchFn = ok();
    const { devSignIn, map } = form(fetchFn as never);
    expect(await devSignIn.signIn({ userId, role: 'member', secret: SECRET })).toEqual({ ok: false, message: DEV_FORM_TEXTS.userId });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(map.size).toBe(0);
  });

  it.each([[''], ['short'], ['a'.repeat(15)], ['a'.repeat(129)], ['has space has space'], ['semi;colon;semi;colon']])(
    'refuses the secret %j (shorter than 16, longer than 128 or outside the alphabet) before any request',
    async (secret) => {
      const fetchFn = ok();
      const { devSignIn } = form(fetchFn as never);
      expect(await devSignIn.signIn({ userId: 'alice', role: 'member', secret })).toEqual({ ok: false, message: DEV_FORM_TEXTS.secret });
      expect(fetchFn).not.toHaveBeenCalled();
      expect(validateDevForm({ userId: 'alice', role: 'member', secret: 'a'.repeat(16) })).toBeNull();
      expect(validateDevForm({ userId: 'alice', role: 'member', secret: 'a'.repeat(128) })).toBeNull();
    },
  );

  it('refuses an unknown role with its text', async () => {
    const fetchFn = ok();
    const { devSignIn } = form(fetchFn as never);
    expect(await devSignIn.signIn({ userId: 'alice', role: 'owner', secret: SECRET })).toEqual({ ok: false, message: DEV_FORM_TEXTS.role });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('shows the rejection text, and stores nothing, when the server does not accept the token (401)', async () => {
    const { devSignIn, map } = form(vi.fn(async () => new Response('{}', { status: 401 })) as never);
    expect(await devSignIn.signIn({ userId: 'alice', role: 'member', secret: SECRET })).toEqual({ ok: false, message: DEV_FORM_TEXTS.rejected });
    expect(map.size).toBe(0);
  });

  it('shows the unreachable text when the request fails', async () => {
    const { devSignIn, map } = form(vi.fn(async () => Promise.reject(new TypeError('network'))) as never);
    expect(await devSignIn.signIn({ userId: 'alice', role: 'member', secret: SECRET })).toEqual({ ok: false, message: DEV_FORM_TEXTS.unreachable });
    expect(map.size).toBe(0);
  });

  it('puts the secret in no message and in no console call', async () => {
    consoleSpy = spyConsole();
    const bad = form(vi.fn(async () => new Response('{}', { status: 401 })) as never);
    const results = [
      await bad.devSignIn.signIn({ userId: 'alice', role: 'member', secret: SECRET }),
      await bad.devSignIn.signIn({ userId: 'Alice', role: 'member', secret: SECRET }),
      await bad.devSignIn.signIn({ userId: 'alice', role: 'member', secret: 'short' }),
    ];
    for (const r of results) expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(consoleSpy.calls().join('\n')).not.toContain(SECRET);
  });
});

describe('storage that ignores the write', () => {
  it('reports a failure, not a sign-in, when the token cannot be kept (blocked or full storage), and leaves nothing behind', async () => {
    const stored = new Map<string, string>();
    const blocked = createClientStorage({ getItem: (k) => stored.get(k) ?? null, setItem: () => {}, removeItem: (k) => void stored.delete(k) });
    const devSignIn = createDevSignIn({ apiUrl: 'http://api.test', storage: blocked, fetch: ok() as never });
    expect(await devSignIn.signIn({ userId: 'alice', role: 'member', secret: SECRET })).toEqual({ ok: false, message: DEV_FORM_TEXTS.notKept });
    expect(devSignIn.read()).toBeNull();
    expect(stored.size).toBe(0);
  });
  it('reports a failure too when only one of the two writes is kept', async () => {
    const stored = new Map<string, string>();
    const half = createClientStorage({ getItem: (k) => stored.get(k) ?? null, setItem: (k, v) => void (k.endsWith('dev-token') && stored.set(k, v)), removeItem: (k) => void stored.delete(k) });
    const devSignIn = createDevSignIn({ apiUrl: 'http://api.test', storage: half, fetch: ok() as never });
    expect((await devSignIn.signIn({ userId: 'alice', role: 'member', secret: SECRET })).ok).toBe(false);
    expect(stored.size).toBe(0);
  });
});

describe('the end of the development token (fake clock)', () => {
  it('signs out when the token is used after its hour, and the next call has no token', async () => {
    const clock = { at: 1_000_000 };
    const { devSignIn, storage, map } = form(ok() as never, () => clock.at);
    await devSignIn.signIn({ userId: 'alice', role: 'viewer', secret: SECRET });
    const auth = createAuth({ config: config(), storage, devSignIn, sdkStorage: fakeSdkStorage(), now: () => clock.at, loadDescope: async () => Promise.reject(new Error('unused')) });
    expect(auth.state()).toEqual({ status: 'signed-in', method: 'dev' });
    clock.at += DEV_TOKEN_LIFE_MS - 1;
    expect(await auth.getToken()).toBe(`dev:${SECRET}:alice:viewer`);
    clock.at += 2;
    expect(await auth.getToken()).toBeNull();
    expect(auth.state()).toEqual({ status: 'signed-out', reason: 'expired' });
    expect(map.size).toBe(0);
  });
});
