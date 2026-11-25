import { useQuery } from '@tanstack/react-query';
import { NO_CACHE, type ApiLike, queryKey } from '../api/query';
import { QUERY_MAX, type SearchPage } from './types';

export const SEARCH_PATH = '/v1/search';

/** The query as it is sent: trimmed, and none at all when there is nothing to search for or it is longer than the API takes. */
export const searchable = (q: string): string | null => {
  const trimmed = q.trim();
  return trimmed.length === 0 || trimmed.length > QUERY_MAX ? null : trimmed;
};

export class SearchError extends Error {
  constructor(readonly status: number) {
    super(`GET ${SEARCH_PATH}: ${String(status)}`);
  }
}

/** One page of results; `cursor` is the `nextCursor` of the page before it. */
export async function fetchSearch(api: ApiLike, q: string, cursor: string | null, signal?: AbortSignal, limit?: number): Promise<SearchPage> {
  const query = { q, ...(cursor === null ? {} : { cursor }), ...(limit === undefined ? {} : { limit }) };
  const { data, response } = await api.GET(SEARCH_PATH as never, { params: { query }, signal } as never);
  if (!response.ok) throw new SearchError(response.status);
  return data as SearchPage;
}

/**
 * The first page of results for `q`, for the palette. What a search finds is the text of pages, so it is not kept in the query cache (R11.5: `gcTime: 0`, and no stale time): a result is read
 * when it is asked for and forgotten when nothing shows it.
 */
export function useSearchPreview(api: ApiLike, q: string, limit: number) {
  const wanted = searchable(q);
  return useQuery<SearchPage, SearchError>({
    ...NO_CACHE,
    enabled: wanted !== null,
    retry: false,
    queryKey: queryKey('GET', SEARCH_PATH, { params: { query: { q: wanted, limit } } }),
    queryFn: ({ signal }) => fetchSearch(api, wanted!, null, signal, limit),
  });
}
