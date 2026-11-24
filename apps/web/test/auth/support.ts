import { vi } from 'vitest';
import { createClientStorage, type ClientStorage } from '../../src/storage';
import type { DescopeModule, DescopeSdk } from '../../src/auth';
import type { ServerConfig } from '../../src/gate/config';

/** A client storage over a map, and the map (to see exactly which keys were written). */
export function fakeStorage(): { storage: ClientStorage; map: Map<string, string> } {
  const map = new Map<string, string>();
  const storage = createClientStorage({ getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) });
  return { storage, map };
}

/** The storage the identity provider's SDK writes to (not prefixed): session and refresh token keys. */
export function fakeSdkStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return { map, getItem: (k: string) => map.get(k) ?? null, removeItem: (k: string) => void map.delete(k) };
}

export const config = (over: Partial<ServerConfig> = {}): ServerConfig =>
  ({ collabUrl: 'ws://x', minClientVersion: '0.0.0', local: true, providerProjectId: null, fileStoreOrigin: null, ...over }) as ServerConfig;

/** A JWT (unsigned: the client only reads `exp`) ending at `exp` seconds since the epoch. */
export const jwt = (exp: number): string => `${btoa('{"alg":"none"}')}.${btoa(JSON.stringify({ exp })).replace(/=+$/, '')}.sig`;

export interface FakeSdk extends DescopeSdk {
  token: string;
  refreshResult: boolean;
  refreshes: number;
  logouts: number;
  /** What the storage held at the moment logout was called (the SDK reads the refresh token from it). */
  atLogout: string[];
}
export function fakeSdk(token: string, isExpired = false, storageKeys: () => string[] = () => []): FakeSdk {
  const sdk: FakeSdk = {
    token,
    refreshResult: true,
    refreshes: 0,
    logouts: 0,
    atLogout: [],
    getSessionToken: () => sdk.token,
    isJwtExpired: () => isExpired,
    refresh: async () => {
      sdk.refreshes += 1;
      return { ok: sdk.refreshResult };
    },
    logout: async () => {
      sdk.logouts += 1;
      sdk.atLogout = storageKeys();
    },
  };
  return sdk;
}
export const moduleOf = (sdk: DescopeSdk): { module: DescopeModule; projectIds: string[] } => {
  const projectIds: string[] = [];
  return {
    module: {
      create: ({ projectId }) => {
        projectIds.push(projectId);
        return sdk;
      },
    },
    projectIds,
  };
};
/** Spies on every console method; `calls()` is every argument of every call as text. */
export function spyConsole() {
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
  return {
    calls: () => spies.flatMap((s) => s.mock.calls.flat().map(String)),
    restore: () => spies.forEach((s) => s.mockRestore()),
  };
}
