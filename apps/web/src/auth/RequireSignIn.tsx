import { type ReactNode, useEffect } from 'react';
import { safeReturn } from '../app/routes';
import type { Auth } from './index';
import { useAuthState } from './session';

/** The sign-in document's address for a page of the app: `/login?return=<page>` and, when a session ended, `&reason=<why>` (a manual sign-out has none). */
export function loginUrl(here: string, reason?: string): string {
  const query = new URLSearchParams({ return: safeReturn(here) });
  if (reason === 'expired' || reason === 'suspended' || reason === 'not-allowed') query.set('reason', reason);
  return `/login?${query.toString()}`;
}

/**
 * Renders the app only while signed in. When signed out it sends the browser to the sign-in document, remembering the page (the path and query only: a page
 * address carries no token) and why the session ended, and renders nothing else meanwhile.
 */
export function RequireSignIn({ auth, here, redirect, children }: { auth: Auth; here: () => string; redirect: (url: string) => void; children: ReactNode }) {
  const state = useAuthState(auth);
  useEffect(() => {
    if (state.status === 'signed-out') redirect(loginUrl(here(), state.reason));
  }, [state, here, redirect]);
  if (state.status !== 'signed-in') return null;
  return <>{children}</>;
}
