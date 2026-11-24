import { useQuery } from '@tanstack/react-query';
import { queryKey } from '../../api/query';
import { useSession } from '../../auth/session';
import type { PageMeta } from './PageView';

export type PageResult = { kind: 'found'; page: PageMeta } | { kind: 'missing' };

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
