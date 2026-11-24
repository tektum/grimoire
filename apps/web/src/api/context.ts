import { useSession } from '../auth/session';
import type { ApiLike } from './query';

/**
 * The typed API client of the signed-in session, for screens: the client of `createWebApi`, wired to the session's token, its refresh and its sign-out
 * (the app builds it once, in `app/App.tsx`). Pass it to `useApiQuery` and `useApiMutation`. The query client provider is above it, in the same place.
 * A screen under test wraps itself in `SessionContext.Provider` (from `auth/session`) with a client over a fake `fetch`.
 */
export function useApi(): ApiLike {
  const session = useSession();
  if (session === null) throw new Error('useApi needs the session of the app: render the screen inside App, or inside a SessionContext.Provider in a test');
  return session.api;
}
