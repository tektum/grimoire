import { createContext, useContext, useSyncExternalStore } from 'react';
import type { ApiLike } from '../api/query';
import type { Auth, AuthState } from './index';

/** What the screens reach for: the session and the API client built from it. Absent in tests of a screen on its own. */
export interface Session {
  readonly auth: Auth;
  readonly api: ApiLike;
  /** The address of the collaboration server, from the server's config. */
  readonly collabUrl: string;
  /** The address of the API: for the one plain request the client makes outside the API client (the check of the minimum version). */
  readonly apiUrl?: string;
}
export const SessionContext = createContext<Session | null>(null);
export const useSession = (): Session | null => useContext(SessionContext);

/** The auth state, re-read when it changes. */
export function useAuthState(auth: Auth): AuthState {
  return useSyncExternalStore(
    (listener) => auth.subscribe(listener),
    () => auth.state(),
  );
}
