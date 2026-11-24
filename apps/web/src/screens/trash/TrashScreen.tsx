import { type InfiniteData, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { components } from '@tektum/grimoire-api-client';
import { type ApiLike, queryKey } from '../../api/query';
import { Button, notify } from '../../ui/primitives';
import { HttpError } from '../../tree/useTree';
import { useCollections } from '../collections/useCollections';
import './trash.css';

/** A batch of deleted pages and a page of the list, as the API answers them: the generated client's shapes. */
type TrashRow = Readonly<components['schemas']['TrashItem']>;
type TrashPage = Readonly<components['schemas']['TrashList']>;

const TRASH_PATH = '/v1/trash';
const trashKey = queryKey('GET', TRASH_PATH, undefined);
const day = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
const days = (n: number): string => `${String(n)} ${n === 1 ? 'day' : 'days'} left`;

/** The pages the caller deleted, or (for an administrator) everybody's: one row per deleted batch, newest first, with Restore. Content is not read here. */
export function TrashScreen({ api }: { readonly api: ApiLike }) {
  const client = useQueryClient();
  const collections = useCollections(api);
  const [restoring, setRestoring] = useState<ReadonlySet<string>>(new Set());
  const trash = useInfiniteQuery<TrashPage, HttpError, InfiniteData<TrashPage, string | null>, readonly unknown[], string | null>({
    queryKey: trashKey,
    initialPageParam: null,
    queryFn: async ({ pageParam, signal }) => {
      const query = pageParam === null ? {} : { cursor: pageParam };
      const { data, response } = await api.GET(TRASH_PATH as never, { params: { query }, signal } as never);
      if (!response.ok) throw new HttpError(response.status);
      return data as TrashPage;
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const names = new Map((collections.data ?? []).map((c) => [c.id, c.name]));
  const rows = trash.data?.pages.flatMap((p) => p.items) ?? [];

  const restore = async (row: TrashRow): Promise<void> => {
    setRestoring((s) => new Set(s).add(row.id));
    try {
      const { response } = await api.POST('/v1/trash/{id}/restore' as never, { params: { path: { id: row.id } } } as never);
      if (response.ok) {
        notify(`Restored ${row.title === '' ? 'Untitled' : row.title}`);
        // Off the list at once: a second Restore would be answered 404 (the batch has left the trash), and a new read of the list may fail.
        client.setQueryData<InfiniteData<TrashPage, string | null>>(trashKey, (data) => data && { ...data, pages: data.pages.map((p) => ({ ...p, items: p.items.filter((i) => i.id !== row.id) })) });
      }
    } catch {
      // The wrapper has shown why (the network); the row stays, and the list is read again below.
    } finally {
      await client.invalidateQueries({ queryKey: trashKey }); // the row stays disabled until the list has been read again
      setRestoring((s) => { const next = new Set(s); next.delete(row.id); return next; });
    }
  };

  return (
    <section aria-labelledby="screen-title" className="trash">
      <h1 id="screen-title">Trash</h1>
      {trash.isError && trash.data === undefined ? (
        <p role="alert">
          Couldn&apos;t load the trash. <Button onClick={() => void trash.refetch()}>Try again</Button>
        </p>
      ) : trash.data === undefined ? (
        <p>Loading</p>
      ) : rows.length === 0 ? (
        <p>The trash is empty</p>
      ) : (
        <>
          <ul className="trash-list">
            {rows.map((row) => {
              const title = row.title === '' ? 'Untitled' : row.title;
              return (
                <li key={row.id}>
                  <span className="trash-title">{title}</span>
                  <span className="trash-meta">
                    {names.get(row.collectionId) === undefined ? '' : `${names.get(row.collectionId) ?? ''} · `}deleted {day.format(row.deletedAt)} · {days(row.daysLeft)}
                  </span>
                  <Button aria-label={`Restore ${title}`} disabled={restoring.has(row.id)} onClick={() => void restore(row)}>
                    Restore
                  </Button>
                </li>
              );
            })}
          </ul>
          {trash.hasNextPage && <Button disabled={trash.isFetchingNextPage} onClick={() => void trash.fetchNextPage()}>Show more</Button>}
        </>
      )}
    </section>
  );
}
