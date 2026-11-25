import { useQuery } from '@tanstack/react-query';
import { queryKey } from '../../api/query';
import { useSession } from '../../auth/session';
import type { PageMeta } from './PageView';

export type PageResult = { kind: 'found'; page: PageMeta } | { kind: 'missing' };

/** True for the cache entries that hold a page record (the page by the id in its address): what the page screen is drawn from. */
export const isPageRecordQuery = (query: { readonly queryKey: readonly unknown[] }): boolean => query.queryKey[0] === 'GET' && query.queryKey[1] === '/v1/pages/by-url-id/{urlId}';

/** The cached answer with only the title changed: whatever else a re-read has brought in since (the permission, the stale flag) is kept. A missing page, or none, stays as it is. */
export const titled = (cached: PageResult | undefined, title: string): PageResult | undefined => (cached?.kind === 'found' ? { kind: 'found', page: { ...cached.page, title } } : cached);

/** The page by the id in its address. A page that is not there and a page the person may not read look the same. */
export function usePage(urlId: string) {
  const session = useSession();
  return useQuery<PageResult>({
    queryKey: queryKey('GET', '/v1/pages/by-url-id/{urlId}', { urlId }),
    enabled: session !== null,
    queryFn: async ({ signal }) => {
      const { data, response } = await session!.api.GET('/v1/pages/by-url-id/{urlId}' as never, { params: { path: { urlId } }, signal } as never);
      if (response.status === 404 || response.status === 403) return { kind: 'missing' };
      if (!response.ok) throw new Error(`GET page: ${response.status}`);
      return { kind: 'found', page: data as PageMeta };
    },
  });
}
