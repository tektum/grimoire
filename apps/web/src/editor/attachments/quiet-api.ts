import { createWebApi } from '../../api/client';
import type { ApiLike } from '../../api/query';
import type { Session } from '../../auth/session';
import { guardedFetch, markClientOutdated } from '../../gate/outdated';

/**
 * The session's API client with its notices turned off: the upload tells a refusal once, in its own words (413, 422, 429 and the rest of the table of messages), so the
 * client must not also toast the generic one. Token, refresh, sign-out, the version header and the retries are the client's own. Absent when the session has no API address.
 */
export function quietApiOf(session: Session): ApiLike | undefined {
  if (session.apiUrl === undefined) return undefined;
  return createWebApi({
    baseUrl: session.apiUrl,
    getToken: () => session.auth.getToken(),
    refresh: () => session.auth.refresh(),
    signOut: (reason) => session.auth.signOut(reason),
    notify: () => undefined,
    reload: markClientOutdated,
    fetch: guardedFetch,
  });
}
