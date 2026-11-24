import { describe, expect, it, vi } from 'vitest';
import { createWebApi } from '../../src/api/client';
import { createAuth, SIGN_OUT_NOTICES, type SignOutReason } from '../../src/auth';
import { createDevSignIn, DEV_TOKEN_EXPIRES_KEY, DEV_TOKEN_KEY } from '../../src/auth/dev-signin';
import { config, fakeSdk, fakeSdkStorage, fakeStorage, jwt } from './support';

const NOW = 2_000_000;
const err = (status: number, code: string) => new Response(JSON.stringify({ error: { code } }), { status, headers: { 'content-type': 'application/json' } });

/** A signed-in development session whose API client reports session ends to `auth.signOut`, as the app wires it. */
function session(reply: Response) {
  const { storage, map } = fakeStorage();
  storage.set(DEV_TOKEN_KEY, `dev:${'ab12'.repeat(8)}:alice:member`);
  storage.set(DEV_TOKEN_EXPIRES_KEY, String(NOW + 3_600_000));
  const auth = createAuth({
    config: config(),
    storage,
    devSignIn: createDevSignIn({ apiUrl: 'http://api', storage, now: () => NOW }),
    sdkStorage: fakeSdkStorage(),
    now: () => NOW,
    loadDescope: async () => Promise.reject(new Error('unused')),
  });
  const notify = vi.fn();
  const client = createWebApi({
    baseUrl: 'https://api.test',
    getToken: () => auth.getToken(),
    refresh: () => auth.refresh(),
    signOut: (reason) => auth.signOut(reason as SignOutReason),
    notify,
    reload: () => {},
    sleep: async () => {},
    fetch: async () => reply,
  });
  return { auth, client, map, notify };
}

describe('a session that the server ends', () => {
  it('account_suspended signs out as suspended, with the text "Your account is suspended"', async () => {
    const t = session(err(403, 'account_suspended'));
    await t.client.GET('/v1/me' as never);
    expect(t.auth.state()).toEqual({ status: 'signed-out', reason: 'suspended' });
    expect(SIGN_OUT_NOTICES.suspended).toBe('Your account is suspended');
    expect(t.map.size).toBe(0);
  });

  it('not_allowed signs out as not-allowed, with the text "This account is not allowed to use Grimoire"', async () => {
    const t = session(err(403, 'not_allowed'));
    await t.client.GET('/v1/me' as never);
    expect(t.auth.state()).toEqual({ status: 'signed-out', reason: 'not-allowed' });
    expect(SIGN_OUT_NOTICES['not-allowed']).toBe('This account is not allowed to use Grimoire');
    expect(t.map.size).toBe(0);
  });

  it('a 401 after the one refresh signs out as expired, with "Please sign in again"', async () => {
    const t = session(err(401, 'unauthenticated'));
    await t.client.GET('/v1/me' as never);
    expect(t.auth.state()).toEqual({ status: 'signed-out', reason: 'expired' });
    expect(SIGN_OUT_NOTICES.expired).toBe('Please sign in again');
  });

  it('keeps the user signed in for an ordinary refusal (403 forbidden is a not-found or a notice, not a sign-out)', async () => {
    const t = session(err(403, 'forbidden'));
    await t.client.GET('/v1/me' as never);
    expect(t.auth.state()).toEqual({ status: 'signed-in', method: 'dev' });
  });

  it('keeps the manual reason when the user signs out while a 401 is being refreshed, although the middleware then signs out as expired', async () => {
    const { storage } = fakeStorage();
    const sdkStorage = fakeSdkStorage({ DSR: 'r' });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const sdk = fakeSdk(jwt(Math.floor(NOW / 1000) + 600));
    sdk.refresh = async () => {
      await gate;
      return { ok: true };
    };
    const auth = createAuth({ config: config({ providerProjectId: 'P' }), storage, devSignIn: null, sdkStorage, now: () => NOW, loadDescope: async () => ({ create: () => sdk }) });
    const client = createWebApi({
      baseUrl: 'https://api.test',
      getToken: () => auth.getToken(),
      refresh: () => auth.refresh(),
      signOut: (reason) => auth.signOut(reason as SignOutReason),
      notify: vi.fn(),
      reload: () => {},
      sleep: async () => {},
      fetch: async () => err(401, 'unauthenticated'),
    });
    const call = client.GET('/v1/me' as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await auth.signOut('manual');
    release();
    await call;
    expect(auth.state()).toEqual({ status: 'signed-out', reason: 'manual' });
  });

  it('has one notice for every reason except a manual sign-out', () => {
    expect(Object.keys(SIGN_OUT_NOTICES).sort()).toEqual(['expired', 'not-allowed', 'suspended']);
  });
});
