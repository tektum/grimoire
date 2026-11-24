import type { ApiClient } from '@tektum/grimoire-api-client';
import type { Session } from '../../auth/session';
import type { FetchUrls, SignedUrl } from './urls';

/**
 * The typed client of the session. The app builds it with `createWebApi` (the generated client of the OpenAPI document with the wrapper's middleware) and hands it to screens as
 * the looser `ApiLike`; this is the one place that says what it really is, so the calls for attachments are checked against the generated types: path, parameters, body and
 * the shape of the answer.
 */
export const clientOf = (session: Pick<Session, 'api'>): ApiClient => session.api as unknown as ApiClient;

/** The signed links of up to 50 attachments in one request (`POST /v1/attachments/urls`); an id the person cannot read is not in the answer. */
export const signedUrlsFrom =
  (api: ApiClient): FetchUrls =>
  async (ids) => {
    const { data, response } = await api.POST('/v1/attachments/urls', { body: { ids } });
    if (!response.ok || data === undefined) throw new Error(`POST /v1/attachments/urls: ${response.status}`);
    return new Map<string, SignedUrl>(data.urls.map((link) => [link.id, { url: link.url, expiresAt: link.expiresAt }]));
  };
