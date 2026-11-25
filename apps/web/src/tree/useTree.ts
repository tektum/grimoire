import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { type ApiLike, queryKey } from '../api/query';
import type { FlatPage } from './model';

export const TREE_PATH = '/v1/collections/{id}/tree';
/** The tree is refetched every minute while the tab is open, and on every return to the window (contracts section 3). */
export const TREE_REFETCH_MS = 60_000;

/** An answer that was not 2xx, with its status, so a screen can tell "not found" from "try again". */
export class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${String(status)}`);
  }
}

export const treeKey = (collectionId: string): readonly unknown[] => queryKey('GET', TREE_PATH, { params: { path: { id: collectionId } } });

/**
 * The flat page list of one collection. Refetched on the window `focus` event (React Query's own focus handling listens to visibility only, and is
 * off here, so one return to the window is exactly one request) and every minute.
 */
export function useCollectionTree(api: ApiLike, collectionId: string | undefined) {
  const query = useQuery<readonly FlatPage[], HttpError>({
    enabled: collectionId !== undefined,
    queryKey: treeKey(collectionId ?? ''),
    queryFn: async ({ signal }) => {
      const { data, response } = await api.GET(TREE_PATH as never, { params: { path: { id: collectionId ?? '' } }, signal } as never);
      if (!response.ok) throw new HttpError(response.status);
      return (data as { pages: readonly FlatPage[] }).pages;
    },
    refetchInterval: TREE_REFETCH_MS,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const { refetch } = query;
  useEffect(() => {
    // `cancelRefetch: false`: a read already under way is reused, not cancelled and started again.
    if (collectionId === undefined) return; // `enabled: false` stops the automatic reads only: a manual one would ask for a tree with no id
    const onFocus = (): void => void refetch({ cancelRefetch: false });
    window.addEventListener('focus', onFocus);
    return () => { window.removeEventListener('focus', onFocus); };
  }, [refetch, collectionId]);
  return query;
}
