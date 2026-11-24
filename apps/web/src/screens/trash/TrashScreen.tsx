import { type InfiniteData, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { type ApiLike, queryKey } from '../../api/query';
import { Button, notify } from '../../ui/primitives';
import { HttpError } from '../../tree/useTree';
import { useCollections } from '../collections/useCollections';
import './trash.css';

/** A batch of deleted pages as the trash lists it: its root page. */
interface TrashRow {
  readonly id: string;
  readonly title: string;
  readonly collectionId: string;
  readonly deletedAt: number;
  readonly daysLeft: number;
}
interface TrashPage {
  readonly items: readonly TrashRow[];
  readonly nextCursor: string | null;
}

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
      if (response.ok) notify(`Restored ${row.title === '' ? 'Untitled' : row.title}`);
    } catch {
      // The wrapper has shown why (the network); the row stays, and the list is read again below.
    } finally {
      setRestoring((s) => { const next = new Set(s); next.delete(row.id); return next; });
      await client.invalidateQueries({ queryKey: trashKey });
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
