import type { ApiLike } from '../../api/query';
import type { FetchUrls, SignedUrl } from './urls';

/** The signed links of up to 50 attachments in one request (`POST /v1/attachments/urls`); an id the person cannot read is not in the answer. */
export const signedUrlsFrom =
  (api: ApiLike): FetchUrls =>
  async (ids) => {
    const { data, response } = await api.POST('/v1/attachments/urls' as never, { body: { ids } } as never);
    if (!response.ok) throw new Error(`POST /v1/attachments/urls: ${response.status}`);
    const urls = (data as { urls: readonly { id: string; url: string; expiresAt: number }[] }).urls;
    return new Map<string, SignedUrl>(urls.map((link) => [link.id, { url: link.url, expiresAt: link.expiresAt }]));
  };
