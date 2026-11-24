import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAuth, DESCOPE_DEVICE_KEY, DESCOPE_REFRESH_KEY, DESCOPE_SESSION_KEY, type AuthState } from '../../src/auth';
import { createDevSignIn, DEV_TOKEN_EXPIRES_KEY, DEV_TOKEN_KEY } from '../../src/auth/dev-signin';
import { config, fakeSdk, fakeSdkStorage, fakeStorage, jwt, moduleOf, spyConsole } from './support';

const NOW = Date.parse('2026-11-24T10:00:00Z');
const secs = (ms: number) => Math.floor(ms / 1000);
const TOKEN = `dev:${'ab12'.repeat(8)}:alice:member`;
let consoleSpy: ReturnType<typeof spyConsole> | undefined;
afterEach(() => consoleSpy?.restore());

function setup(over: { sdkKeys?: Record<string, string>; projectId?: string | null; dev?: boolean; sdkToken?: string; expired?: boolean; now?: () => number } = {}) {
  const { storage, map } = fakeStorage();
  const sdkStorage = fakeSdkStorage(over.sdkKeys);
  const sdk = fakeSdk(over.sdkToken ?? '', over.expired ?? false, () => [...sdkStorage.map.keys()]);
  const loader = moduleOf(sdk);
  let loads = 0;
  const now = over.now ?? (() => NOW);
  const devSignIn = over.dev === false ? null : createDevSignIn({ apiUrl: 'http://api', storage, now });
  const auth = createAuth({
    config: config({ providerProjectId: over.projectId === undefined ? null : over.projectId }),
    storage,
    devSignIn,
    sdkStorage,
    now,
    loadDescope: async () => (loads++, loader.module),
  });
  return { auth, storage, map, sdkStorage, sdk, loader, loads: () => loads, devSignIn };
}

const storeDevToken = (t: ReturnType<typeof setup>, expiresAt = NOW + 3_600_000) => {
  t.storage.set(DEV_TOKEN_KEY, TOKEN);
  t.storage.set(DEV_TOKEN_EXPIRES_KEY, String(expiresAt));
};

describe('createAuth: development token', () => {
  it('is signed out with nothing stored, and getToken is null', async () => {
    const t = setup();
    expect(t.auth.state()).toEqual({ status: 'signed-out' });
    expect(await t.auth.getToken()).toBeNull();
  });

  it('getToken returns the stored development token, and the state says dev', async () => {
    const t = setup();
    storeDevToken(t);
    const again = createAuth({ config: config(), storage: t.storage, devSignIn: t.devSignIn, sdkStorage: t.sdkStorage, now: () => NOW, loadDescope: async () => t.loader.module });
    expect(again.state()).toEqual({ status: 'signed-in', method: 'dev' });
    expect(await again.getToken()).toBe(TOKEN);
  });

  it('ignores a stored development token in a build without the development sign-in', () => {
    const t = setup({ dev: false });
    storeDevToken(t);
    expect(t.auth.state()).toEqual({ status: 'signed-out' });
  });

  it('refresh() is false for a development token, which cannot be refreshed, and signs out', async () => {
    const clock = { at: NOW };
    const t = setup({ now: () => clock.at });
    storeDevToken(t);
    const auth = createAuth({ config: config(), storage: t.storage, devSignIn: t.devSignIn, sdkStorage: t.sdkStorage, now: () => clock.at, loadDescope: async () => t.loader.module });
    expect(await auth.refresh()).toBe(false);
    expect(auth.state()).toEqual({ status: 'signed-out', reason: 'expired' });
    expect(t.map.size).toBe(0);
  });

  it('signs out as expired when the hour of the token has passed', async () => {
    const clock = { at: NOW };
    const t = setup({ now: () => clock.at });
    storeDevToken(t);
    const auth = createAuth({ config: config(), storage: t.storage, devSignIn: t.devSignIn, sdkStorage: t.sdkStorage, now: () => clock.at, loadDescope: async () => t.loader.module });
    clock.at = NOW + 3_600_001;
    expect(await auth.getToken()).toBeNull();
    expect(auth.state()).toEqual({ status: 'signed-out', reason: 'expired' });
  });
});

describe('createAuth: identity provider session', () => {
  it('does not load the SDK for a signed-out start, nor for a session it only needs to name', () => {
    const none = setup({ projectId: 'P-test' });
    expect(none.auth.state()).toEqual({ status: 'signed-out' });
    expect(none.loads()).toBe(0);
    const some = setup({ projectId: 'P-test', sdkKeys: { [DESCOPE_REFRESH_KEY]: 'r' } });
    expect(some.auth.state()).toEqual({ status: 'signed-in', method: 'descope' });
    expect(some.loads()).toBe(0);
  });

  it('is signed out when no project is configured, whatever the SDK keys say', () => {
    expect(setup({ projectId: null, sdkKeys: { [DESCOPE_SESSION_KEY]: 's' } }).auth.state()).toEqual({ status: 'signed-out' });
  });

  it('hands out a token that is good for more than 60 s without a refresh, loading the SDK with the project id', async () => {
    const t = setup({ projectId: 'P-test', sdkKeys: { [DESCOPE_REFRESH_KEY]: 'r' }, sdkToken: jwt(secs(NOW) + 600) });
    expect(await t.auth.getToken()).toBe(t.sdk.token);
    expect(t.sdk.refreshes).toBe(0);
    expect(t.loader.projectIds).toEqual(['P-test']);
    await t.auth.getToken();
    expect(t.loads()).toBe(1);
  });

  it('asks the SDK to refresh a token that ends within 60 s, and hands out the new one', async () => {
    const t = setup({ projectId: 'P-test', sdkKeys: { [DESCOPE_REFRESH_KEY]: 'r' }, sdkToken: jwt(secs(NOW) + 59) });
    const fresh = jwt(secs(NOW) + 3600);
    t.sdk.refresh = async () => {
      t.sdk.refreshes += 1;
      t.sdk.token = fresh;
      return { ok: true };
    };
    expect(await t.auth.getToken()).toBe(fresh);
    expect(t.sdk.refreshes).toBe(1);
  });

  it('also refreshes a token the SDK reports as expired, and one it cannot read', async () => {
    const expired = setup({ projectId: 'P', sdkKeys: { [DESCOPE_REFRESH_KEY]: 'r' }, sdkToken: jwt(secs(NOW) + 3600), expired: true });
    await expired.auth.getToken();
    expect(expired.sdk.refreshes).toBe(1);
    const empty = setup({ projectId: 'P', sdkKeys: { [DESCOPE_REFRESH_KEY]: 'r' }, sdkToken: '' });
    expect(await empty.auth.getToken()).toBeNull();
    expect(empty.sdk.refreshes).toBe(1);
  });

  it('refresh() is false after a failed refresh, and the client is signed out as expired with the SDK keys gone', async () => {
    const t = setup({ projectId: 'P-test', sdkKeys: { [DESCOPE_REFRESH_KEY]: 'r', [DESCOPE_SESSION_KEY]: 's' }, sdkToken: jwt(secs(NOW) + 5) });
    t.sdk.refreshResult = false;
    expect(await t.auth.refresh()).toBe(false);
    expect(t.auth.state()).toEqual({ status: 'signed-out', reason: 'expired' });
    expect(t.sdkStorage.map.size).toBe(0);
    expect(await t.auth.getToken()).toBeNull();
  });

  it('treats a throwing SDK as a failed refresh', async () => {
    const t = setup({ projectId: 'P', sdkKeys: { [DESCOPE_REFRESH_KEY]: 'r' }, sdkToken: jwt(secs(NOW) + 5) });
    t.sdk.refresh = async () => {
      throw new Error('network');
    };
    expect(await t.auth.refresh()).toBe(false);
    expect(t.auth.state()).toMatchObject({ status: 'signed-out', reason: 'expired' });
  });

  it('gives null, not an error, when the SDK cannot be loaded', async () => {
    const { storage } = fakeStorage();
    const auth = createAuth({
      config: config({ providerProjectId: 'P' }),
      storage,
      devSignIn: null,
      sdkStorage: fakeSdkStorage({ [DESCOPE_REFRESH_KEY]: 'r' }),
      loadDescope: async () => Promise.reject(new Error('chunk failed')),
    });
    expect(await auth.getToken()).toBeNull();
  });
});

describe('signOut', () => {
  it('clears every key it wrote (the development token and its expiry, the SDK keys), tells subscribers once with the reason, and stops after unsubscribe', async () => {
    const t = setup({ projectId: 'P', sdkKeys: { [DESCOPE_REFRESH_KEY]: 'r', [DESCOPE_SESSION_KEY]: 's' } });
    storeDevToken(t);
    t.storage.set('last-collection', 'c1'); // a preference of the client, not a session key: it stays
    const seen: AuthState[] = [];
    const stop = t.auth.subscribe((s) => seen.push(s));
    await t.auth.signOut('suspended');
    expect(seen).toEqual([{ status: 'signed-out', reason: 'suspended' }]);
    expect([...t.map.keys()]).toEqual(['grimoire.last-collection']);
    expect(t.sdkStorage.map.size).toBe(0);
    stop();
    await t.auth.signOut('manual');
    expect(seen).toHaveLength(1);
  });

  it('calls the SDK logout for a manual sign-out once the SDK is loaded, and not for an ended session', async () => {
    const manual = setup({ projectId: 'P', sdkKeys: { [DESCOPE_REFRESH_KEY]: 'r' }, sdkToken: jwt(secs(NOW) + 600) });
    await manual.auth.getToken();
    await manual.auth.signOut();
    expect(manual.sdk.logouts).toBe(1);
    expect(manual.auth.state()).toEqual({ status: 'signed-out', reason: 'manual' });
    const ended = setup({ projectId: 'P', sdkKeys: { [DESCOPE_REFRESH_KEY]: 'r' }, sdkToken: jwt(secs(NOW) + 600) });
    await ended.auth.getToken();
    await ended.auth.signOut('expired');
    expect(ended.sdk.logouts).toBe(0);
  });
});

describe('signOut at the provider', () => {
  it('revokes the session while the refresh token is still in storage, then clears every SDK key (DS, DSR, DSI)', async () => {
    const t = setup({ projectId: 'P', sdkKeys: { [DESCOPE_REFRESH_KEY]: 'r', [DESCOPE_SESSION_KEY]: 's', [DESCOPE_DEVICE_KEY]: 'd' }, sdkToken: jwt(secs(NOW) + 600) });
    await t.auth.getToken();
    await t.auth.signOut();
    expect(t.sdk.logouts).toBe(1);
    expect(t.sdk.atLogout.sort()).toEqual([DESCOPE_DEVICE_KEY, DESCOPE_REFRESH_KEY, DESCOPE_SESSION_KEY].sort());
    expect(t.sdkStorage.map.size).toBe(0);
  });

  it('loads the SDK for a sign-out right after a page load, with a session and nothing loaded yet, and still revokes first', async () => {
    const t = setup({ projectId: 'P', sdkKeys: { [DESCOPE_REFRESH_KEY]: 'r' } });
    expect(t.loads()).toBe(0);
    await t.auth.signOut();
    expect(t.loads()).toBe(1);
    expect(t.sdk.logouts).toBe(1);
    expect(t.sdk.atLogout).toEqual([DESCOPE_REFRESH_KEY]);
    expect(t.sdkStorage.map.size).toBe(0);
  });

  it('still ends the session, and clears the keys, when the provider cannot be reached or the SDK cannot be loaded', async () => {
    const t = setup({ projectId: 'P', sdkKeys: { [DESCOPE_REFRESH_KEY]: 'r', [DESCOPE_DEVICE_KEY]: 'd' } });
    t.sdk.logout = async () => {
      throw new Error('offline');
    };
    await t.auth.signOut();
    expect(t.auth.state()).toEqual({ status: 'signed-out', reason: 'manual' });
    expect(t.sdkStorage.map.size).toBe(0);
    const { storage } = fakeStorage();
    const sdkStorage = fakeSdkStorage({ [DESCOPE_REFRESH_KEY]: 'r' });
    const auth = createAuth({ config: config({ providerProjectId: 'P' }), storage, devSignIn: null, sdkStorage, loadDescope: async () => Promise.reject(new Error('chunk failed')) });
    await auth.signOut();
    expect(auth.state()).toEqual({ status: 'signed-out', reason: 'manual' });
    expect(sdkStorage.map.size).toBe(0);
  });

  it('does not touch the provider for a session that has already ended (expired, suspended, not allowed), and clears the keys', async () => {
    for (const reason of ['expired', 'suspended', 'not-allowed'] as const) {
      const t = setup({ projectId: 'P', sdkKeys: { [DESCOPE_REFRESH_KEY]: 'r', [DESCOPE_DEVICE_KEY]: 'd' } });
      await t.auth.signOut(reason);
      expect([reason, t.loads(), t.sdk.logouts, t.sdkStorage.map.size]).toEqual([reason, 0, 0, 0]);
    }
  });
});

describe('concurrent token requests', () => {
  it('share one refresh: five calls at the expiry edge send one, and all get the new token', async () => {
    const t = setup({ projectId: 'P', sdkKeys: { [DESCOPE_REFRESH_KEY]: 'r' }, sdkToken: jwt(secs(NOW) + 30) });
    const fresh = jwt(secs(NOW) + 3600);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    t.sdk.refresh = async () => {
      t.sdk.refreshes += 1;
      await gate;
      t.sdk.token = fresh;
      return { ok: true };
    };
    const calls = Array.from({ length: 5 }, () => t.auth.getToken());
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    expect(await Promise.all(calls)).toEqual([fresh, fresh, fresh, fresh, fresh]);
    expect(t.sdk.refreshes).toBe(1);
    // After it finished, a later ending token gets its own refresh.
    t.sdk.token = jwt(secs(NOW) + 10);
    await t.auth.getToken();
    expect(t.sdk.refreshes).toBe(2);
  });

  it('share a failed refresh too: all get null, and the client signs out once', async () => {
    const t = setup({ projectId: 'P', sdkKeys: { [DESCOPE_REFRESH_KEY]: 'r' }, sdkToken: jwt(secs(NOW) + 30) });
    t.sdk.refreshResult = false;
    const seen: AuthState[] = [];
    t.auth.subscribe((s) => seen.push(s));
    expect(await Promise.all([t.auth.getToken(), t.auth.getToken(), t.auth.refresh()])).toEqual([null, null, false]);
    expect(t.sdk.refreshes).toBe(1);
    expect(seen).toEqual([{ status: 'signed-out', reason: 'expired' }]);
  });
});

describe('a sign-out that overlaps other work', () => {
  it('does not wait for a provider that never answers: the session ends after the time limit, with the keys cleared', async () => {
    vi.useFakeTimers();
    try {
      const t = setup({ projectId: 'P', sdkKeys: { [DESCOPE_REFRESH_KEY]: 'r', [DESCOPE_DEVICE_KEY]: 'd' } });
      t.sdk.logout = () => new Promise(() => {}); // never settles
      let done = false;
      const out = t.auth.signOut().then(() => (done = true));
      await vi.advanceTimersByTimeAsync(4999);
      expect(done).toBe(false);
      expect(t.auth.state().status).toBe('signed-in');
      await vi.advanceTimersByTimeAsync(1);
      await out;
      expect(t.auth.state()).toEqual({ status: 'signed-out', reason: 'manual' });
      expect(t.sdkStorage.map.size).toBe(0);
      expect(await t.auth.getToken()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not wait for an SDK that never loads either', async () => {
    vi.useFakeTimers();
    try {
      const { storage } = fakeStorage();
      const sdkStorage = fakeSdkStorage({ [DESCOPE_REFRESH_KEY]: 'r' });
      const auth = createAuth({ config: config({ providerProjectId: 'P' }), storage, devSignIn: null, sdkStorage, logoutTimeoutMs: 100, loadDescope: () => new Promise(() => {}) });
      const out = auth.signOut();
      await vi.advanceTimersByTimeAsync(100);
      await out;
      expect(auth.state()).toEqual({ status: 'signed-out', reason: 'manual' });
      expect(sdkStorage.map.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the session ended when a refresh that was in flight succeeds late: the token request gets null, the state is not brought back', async () => {
    const t = setup({ projectId: 'P', sdkKeys: { [DESCOPE_REFRESH_KEY]: 'r' }, sdkToken: jwt(secs(NOW) + 20) });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    t.sdk.refresh = async () => {
      await gate;
      t.sdk.token = jwt(secs(NOW) + 3600);
      return { ok: true };
    };
    const pending = t.auth.getToken();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await t.auth.signOut('manual');
    release();
    expect(await pending).toBeNull();
    expect(t.auth.state()).toEqual({ status: 'signed-out', reason: 'manual' });
  });

  it('does not sign out a second time, nor change the reason, when a refresh that was in flight fails late', async () => {
    const t = setup({ projectId: 'P', sdkKeys: { [DESCOPE_REFRESH_KEY]: 'r' }, sdkToken: jwt(secs(NOW) + 20) });
    let fail: () => void = () => {};
    const gate = new Promise<void>((resolve) => (fail = resolve));
    t.sdk.refresh = async () => {
      await gate;
      return { ok: false };
    };
    const seen: AuthState[] = [];
    t.auth.subscribe((s) => seen.push(s));
    const pending = t.auth.refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await t.auth.signOut('suspended');
    fail();
    expect(await pending).toBe(false);
    expect(seen).toEqual([{ status: 'signed-out', reason: 'suspended' }]);
  });
});

describe('browser storage that throws on access', () => {
  it('builds a signed-out auth when reading localStorage itself throws', () => {
    const real = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
    });
    try {
      const { storage } = fakeStorage();
      const auth = createAuth({ config: config({ providerProjectId: 'P' }), storage, devSignIn: null, loadDescope: async () => Promise.reject(new Error('unused')) });
      expect(auth.state()).toEqual({ status: 'signed-out' });
    } finally {
      if (real) Object.defineProperty(globalThis, 'localStorage', real);
    }
  });
});

describe('what the run writes to the console', () => {
  it('holds neither the development token nor the identity provider token', async () => {
    consoleSpy = spyConsole();
    const token = jwt(secs(NOW) + 5);
    const t = setup({ projectId: 'P', sdkKeys: { [DESCOPE_REFRESH_KEY]: 'r' }, sdkToken: token });
    t.sdk.refreshResult = false;
    await t.auth.getToken();
    await t.auth.refresh();
    const dev = setup();
    storeDevToken(dev);
    await dev.auth.signOut('manual');
    const text = consoleSpy.calls().join('\n');
    expect(text).toContain('web.sign_out'); // something was logged...
    for (const secret of [token, TOKEN, 'ab12'.repeat(8)]) expect(text).not.toContain(secret); // ...and none of it holds a secret
  });
});
