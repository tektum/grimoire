import { log } from '../logging';
import type { ClientStorage } from '../storage';
import type { ServerConfig } from '../gate/config';
import type { DevSignIn } from './dev-signin';
import { jwtExpiresAt } from './jwt';

export type SignOutReason = 'expired' | 'suspended' | 'not-allowed' | 'manual';
export type AuthState = { status: 'loading' } | { status: 'signed-out'; reason?: SignOutReason } | { status: 'signed-in'; method: 'descope' | 'dev' };

export interface Auth {
  state(): AuthState;
  subscribe(fn: (state: AuthState) => void): () => void;
  /** The current session token (a development token as stored; a Descope token refreshed first when it ends within 60 s); null when signed out. */
  getToken(): Promise<string | null>;
  /** One refresh. False means sign in again (a development token cannot be refreshed). */
  refresh(): Promise<boolean>;
  signOut(reason?: SignOutReason): Promise<void>;
}

/** The part of the identity provider's web SDK the client uses. `createAuth` loads it only when a Descope session exists. */
export interface DescopeSdk {
  getSessionToken(): string;
  isJwtExpired(token: string): boolean;
  refresh(): Promise<{ ok: boolean }>;
  logout(): Promise<unknown>;
}
export interface DescopeModule {
  create(config: { projectId: string }): DescopeSdk;
}

/** The keys the identity provider's SDK keeps in local storage (session and refresh token). They are removed on sign-out. */
export const DESCOPE_SESSION_KEY = 'DS';
export const DESCOPE_REFRESH_KEY = 'DSR';
/** Also kept by the SDK; removed with the other two on every sign-out. */
export const DESCOPE_DEVICE_KEY = 'DSI';
/** A Descope token that ends within this long is refreshed before it is handed out. */
export const REFRESH_WITHIN_MS = 60_000;

export interface CreateAuthOptions {
  readonly config: ServerConfig;
  readonly storage: ClientStorage;
  readonly loadDescope: () => Promise<DescopeModule>;
  /** The development sign-in: null in a production build, or when the server is not in local mode. */
  readonly devSignIn: DevSignIn | null;
  readonly now?: () => number;
  /** How long a manual sign-out waits for the provider to end the session before it goes on (ms). */
  readonly logoutTimeoutMs?: number;
  /** The local storage the identity provider's SDK writes to (a test passes a fake). */
  readonly sdkStorage?: Pick<Storage, 'getItem' | 'removeItem'>;
}

export function createAuth(o: CreateAuthOptions): Auth {
  const now = o.now ?? Date.now;
  // Reading `localStorage` itself can throw (site data blocked): then there is no SDK storage, and the client is simply signed out.
  const sdkStorage =
    o.sdkStorage ??
    ((): Pick<Storage, 'getItem' | 'removeItem'> | null => {
      try {
        return typeof localStorage === 'undefined' ? null : localStorage;
      } catch {
        return null;
      }
    })();
  const listeners = new Set<(state: AuthState) => void>();
  let sdk: Promise<DescopeSdk> | null = null;
  // One refresh at a time: a burst of requests that all see an ending token shares it (the refresh token may rotate, and a second use would fail).
  let refreshing: Promise<boolean> | null = null;
  // Counts sign-outs: a refresh that was started before one must not bring the session back, or sign out a second time.
  let epoch = 0;

  const hasDescopeSession = (): boolean => {
    try {
      return sdkStorage?.getItem(DESCOPE_REFRESH_KEY) != null || sdkStorage?.getItem(DESCOPE_SESSION_KEY) != null;
    } catch {
      return false;
    }
  };
  const devToken = () => {
    const stored = o.devSignIn?.read() ?? null;
    return stored !== null && stored.expiresAt > now() ? stored : null;
  };
  const initial = (): AuthState => {
    if (devToken() !== null) return { status: 'signed-in', method: 'dev' };
    if (o.config.providerProjectId !== null && hasDescopeSession()) return { status: 'signed-in', method: 'descope' };
    return { status: 'signed-out' };
  };
  let current: AuthState = initial();
  const set = (next: AuthState) => {
    current = next;
    for (const fn of [...listeners]) fn(next);
  };
  const descope = (): Promise<DescopeSdk> => {
    const projectId = o.config.providerProjectId;
    if (projectId === null) return Promise.reject(new Error('No sign-in project is configured'));
    sdk ??= o.loadDescope().then((m) => m.create({ projectId }));
    return sdk;
  };

  // The provider's logout, but never longer than `logoutTimeoutMs`: a stalled connection or an SDK that never loads must not hold the sign-out.
  const boundedLogout = async (): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const giveUp = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, o.logoutTimeoutMs ?? 5000);
    });
    try {
      await Promise.race([
        descope()
          .then((client) => client.logout())
          .then(
            () => undefined,
            () => undefined,
          ),
        giveUp,
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  const auth: Auth = {
    state: () => current,
    subscribe(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    async getToken() {
      if (current.status !== 'signed-in') return null;
      if (current.method === 'dev') {
        const stored = devToken();
        if (stored === null) {
          await auth.signOut('expired');
          return null;
        }
        return stored.token;
      }
      try {
        const client = await descope();
        let token = client.getSessionToken();
        const ends = token === '' ? null : jwtExpiresAt(token);
        if (token === '' || client.isJwtExpired(token) || (ends !== null && ends - now() < REFRESH_WITHIN_MS)) {
          if (!(await auth.refresh())) return null;
          if (current.status !== 'signed-in') return null;
          token = client.getSessionToken();
        }
        return token === '' ? null : token;
      } catch {
        log('warn', 'web.auth_error', { stage: 'token' });
        return null;
      }
    },
    refresh() {
      if (current.status !== 'signed-in' || current.method === 'dev') {
        return current.status === 'signed-in' ? auth.signOut('expired').then(() => false) : Promise.resolve(false);
      }
      refreshing ??= (async () => {
        const started = epoch;
        let refreshed = false;
        try {
          refreshed = (await (await descope()).refresh()).ok;
        } catch {
          log('warn', 'web.auth_error', { stage: 'refresh' });
        }
        if (epoch !== started) return false; // signed out meanwhile: stays signed out, and no second sign-out
        if (refreshed) return true;
        await auth.signOut('expired');
        return false;
      })().finally(() => {
        refreshing = null;
      });
      return refreshing;
    },
    async signOut(reason = 'manual') {
      // A session that has already ended keeps the reason it ended with: a late "expired" (the API middleware reacting to a refresh that was cut short)
      // must not replace the user's own sign-out. The keys are removed again, which costs nothing.
      if (current.status === 'signed-out' && current.reason !== undefined) {
        o.devSignIn?.clear();
        return;
      }
      epoch += 1;
      o.devSignIn?.clear();
      // A manual sign-out ends the session at the provider first: the SDK reads the refresh token from storage to revoke it, so the keys must still be there.
      // The SDK is loaded for it when a session exists and it is not loaded yet. Whatever the provider does, the keys are removed after, and the session ends.
      if (reason === 'manual' && o.config.providerProjectId !== null && (sdk !== null || hasDescopeSession())) await boundedLogout();
      try {
        for (const key of [DESCOPE_SESSION_KEY, DESCOPE_REFRESH_KEY, DESCOPE_DEVICE_KEY]) sdkStorage?.removeItem(key);
      } catch {
        // storage blocked: nothing to remove
      }
      log('info', 'web.sign_out', { reason });
      set({ status: 'signed-out', reason });
    },
  };
  return auth;
}

/** The notice shown on the sign-in screen after a session ended (contracts section 4). */
export const SIGN_OUT_NOTICES: Readonly<Record<Exclude<SignOutReason, 'manual'>, string>> = {
  expired: 'Please sign in again',
  suspended: 'Your account is suspended',
  'not-allowed': 'This account is not allowed to use Grimoire',
};
