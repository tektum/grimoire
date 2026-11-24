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
/** A Descope token that ends within this long is refreshed before it is handed out. */
export const REFRESH_WITHIN_MS = 60_000;

export interface CreateAuthOptions {
  readonly config: ServerConfig;
  readonly storage: ClientStorage;
  readonly loadDescope: () => Promise<DescopeModule>;
  /** The development sign-in: null in a production build, or when the server is not in local mode. */
  readonly devSignIn: DevSignIn | null;
  readonly now?: () => number;
  /** The local storage the identity provider's SDK writes to (a test passes a fake). */
  readonly sdkStorage?: Pick<Storage, 'getItem' | 'removeItem'>;
}

export function createAuth(o: CreateAuthOptions): Auth {
  const now = o.now ?? Date.now;
  const sdkStorage = o.sdkStorage ?? (typeof localStorage === 'undefined' ? null : localStorage);
  const listeners = new Set<(state: AuthState) => void>();
  let sdk: Promise<DescopeSdk> | null = null;

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
          token = client.getSessionToken();
        }
        return token === '' ? null : token;
      } catch {
        log('warn', 'web.auth_error', { stage: 'token' });
        return null;
      }
    },
    async refresh() {
      if (current.status !== 'signed-in' || current.method === 'dev') {
        if (current.status === 'signed-in') await auth.signOut('expired');
        return false;
      }
      try {
        const result = await (await descope()).refresh();
        if (result.ok) return true;
      } catch {
        log('warn', 'web.auth_error', { stage: 'refresh' });
      }
      await auth.signOut('expired');
      return false;
    },
    async signOut(reason = 'manual') {
      o.devSignIn?.clear();
      // Local storage is cleared first and whatever the SDK does: the session must end even when the provider cannot be reached.
      const hadDescope = hasDescopeSession() || sdk !== null;
      try {
        sdkStorage?.removeItem(DESCOPE_SESSION_KEY);
        sdkStorage?.removeItem(DESCOPE_REFRESH_KEY);
      } catch {
        // storage blocked: nothing to remove
      }
      if (reason === 'manual' && hadDescope && sdk !== null) await sdk.then((client) => client.logout()).catch(() => undefined);
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
