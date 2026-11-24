import { type InfiniteData, useInfiniteQuery } from '@tanstack/react-query';
import type { components } from '@tektum/grimoire-api-client';
import { Link } from 'react-router';
import { type ApiLike, queryKey } from '../../api/query';
import { HttpError } from '../../tree/useTree';
import { Button } from '../../ui/primitives';
import NotFoundScreen from '../notfound';
import './history.css';
import { RevisionMeta } from './RevisionMeta';

type Page = Readonly<{ items: readonly components['schemas']['Revision'][]; nextCursor: string | null }>;
export interface HistoryPage {
  readonly id: string;
  readonly title: string;
  /** What the person may do with the page: only `read-write` may restore. */
  readonly myPermission: 'read-write' | 'read-only';
}

/** The versions of a page, newest first, a few at a time (R9.4). A page nobody may read is "not found", whichever the reason (R11.15). */
export function RevisionList({ api, page, slug }: { readonly api: ApiLike; readonly page: HistoryPage; readonly slug: string }) {
  const list = useInfiniteQuery<Page, HttpError, InfiniteData<Page, string | null>, readonly unknown[], string | null>({
    queryKey: queryKey('GET', '/v1/pages/{id}/revisions', { params: { path: { id: page.id } } }),
    initialPageParam: null,
    queryFn: async ({ pageParam, signal }) => {
      const query = pageParam === null ? {} : { cursor: pageParam };
      const { data, response } = await api.GET('/v1/pages/{id}/revisions' as never, { params: { path: { id: page.id }, query }, signal } as never);
      if (!response.ok) throw new HttpError(response.status);
      return data as Page;
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  if (list.error?.status === 404 || list.error?.status === 403) return <NotFoundScreen />;
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <section aria-labelledby="screen-title" className="history-screen">
      <p>
        <Link to={`/p/${slug}`}>Back to {page.title}</Link>
      </p>
      <h1 id="screen-title">History of {page.title}</h1>
      {list.isError && list.data === undefined ? (
        <p role="alert">
          Couldn&apos;t load the versions. <Button onClick={() => void list.refetch()}>Try again</Button>
        </p>
      ) : list.data === undefined ? (
        <p>Loading</p>
      ) : items.length === 0 ? (
        <p>No saved versions yet</p>
      ) : (
        <>
          <ul className="history-list">
            {items.map((revision) => (
              <li key={revision.id}>
                <RevisionMeta revision={revision} />
                <Link to={`/p/${slug}/history/${revision.id}`} aria-label={`Open this version, ${new Date(revision.createdAt).toLocaleString()}`}>
                  Open
                </Link>
              </li>
            ))}
          </ul>
          {list.isFetchNextPageError && <p role="alert">Couldn&apos;t load more versions.</p>}
          {list.hasNextPage && (
            <Button disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              Show more
            </Button>
          )}
        </>
      )}
    </section>
  );
}
