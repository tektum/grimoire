import type { components } from '@tektum/grimoire-api-client';
import { useQuery } from '@tanstack/react-query';
import { type ApiLike, queryKey } from '../../api/query';
import { HttpError } from '../../tree/useTree';

/** A collection as the API lists it: the generated client's shape. */
export type CollectionItem = Readonly<components['schemas']['Collection']>;

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

/** One collection by its id: a 404 or 403 here is the same "not found" the person is shown (R11.15), whichever it was. */
export function useCollection(api: ApiLike, id: string) {
  return useQuery<CollectionItem, HttpError>({
    queryKey: queryKey('GET', '/v1/collections/{id}', { params: { path: { id } } }),
    queryFn: async ({ signal }) => {
      const { data, response } = await api.GET('/v1/collections/{id}' as never, { params: { path: { id } }, signal } as never);
      if (!response.ok) throw new HttpError(response.status);
      return data as CollectionItem;
    },
    retry: false,
  });
}
