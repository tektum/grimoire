import { useQuery } from '@tanstack/react-query';
import { type ApiLike, queryKey } from '../../api/query';
import { HttpError } from '../../tree/useTree';

export interface CollectionItem {
  readonly id: string;
  readonly name: string;
  readonly icon: string | null;
  readonly myPermission: 'read-write' | 'read-only';
}

export const LIST_PATH = '/v1/collections';
/** The `ClientStorage` key of the collection that was read last (contracts section 3). */
export const LAST_COLLECTION_KEY = 'last-collection';

/** The collections the caller can read, in the server's order. */
export function useCollections(api: ApiLike) {
  return useQuery<readonly CollectionItem[], HttpError>({
    queryKey: queryKey('GET', LIST_PATH, undefined),
    queryFn: async ({ signal }) => {
      const { data, response } = await api.GET(LIST_PATH as never, { signal } as never);
      if (!response.ok) throw new HttpError(response.status);
      return (data as { items: readonly CollectionItem[] }).items;
    },
  });
}
