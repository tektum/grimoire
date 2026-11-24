import { type InfiniteData, useInfiniteQuery } from '@tanstack/react-query';
import type { components } from '@tektum/grimoire-api-client';
import { type FormEvent, useState } from 'react';
import { type ApiLike, queryKey } from '../../api/query';
import { HttpError } from '../../tree/useTree';
import { Button } from '../../ui/primitives';

type AdminUser = Readonly<components['schemas']['AdminUser']>;
type UserList = Readonly<components['schemas']['AdminUserList']>;
const PAGE = 10;

/**
 * Finds people by a word of their name or email and offers an action on each (add to a group, grant access). People in `exclude` are not offered. The search
 * is the administrators' user list (`GET /v1/users?q`), a few at a time.
 */
export function UserPicker({ api, label, exclude, actionLabel, onPick }: {
  readonly api: ApiLike;
  readonly label: string;
  readonly exclude: ReadonlySet<string>;
  readonly actionLabel: (name: string) => string;
  readonly onPick: (user: AdminUser) => void;
}) {
  const [draft, setDraft] = useState('');
  const [q, setQ] = useState('');
  const found = useInfiniteQuery<UserList, HttpError, InfiniteData<UserList, string | null>, readonly unknown[], string | null>({
    enabled: q !== '',
    queryKey: queryKey('GET', '/v1/users', { params: { query: { q, limit: PAGE } } }),
    initialPageParam: null,
    queryFn: async ({ pageParam, signal }) => {
      const query = { q, limit: PAGE, ...(pageParam === null ? {} : { cursor: pageParam }) };
      const { data, response } = await api.GET('/v1/users' as never, { params: { query }, signal } as never);
      if (!response.ok) throw new HttpError(response.status);
      return data as UserList;
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const offered = (found.data?.pages.flatMap((p) => p.items) ?? []).filter((u) => !exclude.has(u.id));
  const search = (event: FormEvent): void => {
    event.preventDefault();
    setQ(draft.trim());
  };
  return (
    <div className="admin-picker">
      <form role="search" onSubmit={search} className="admin-search">
        <input type="search" aria-label={label} placeholder="Name or email" maxLength={200} value={draft} onChange={(e) => { setDraft(e.target.value); }} />
        <Button type="submit">Find</Button>
      </form>
      {found.isError && (
        <p role="alert">
          Couldn&apos;t search. <Button onClick={() => void (found.isFetchNextPageError ? found.fetchNextPage() : found.refetch())}>Try again</Button>
        </p>
      )}
      {q !== '' && found.data !== undefined && offered.length === 0 && !found.hasNextPage && !found.isError && <p>No one to add</p>}
      <ul className="admin-list">
        {offered.map((u) => (
          <li key={u.id}>
            <div className="admin-main">
              <h3>{u.name}</h3>
              <span className="admin-meta">{u.email}</span>
            </div>
            <Button aria-label={actionLabel(u.name)} onClick={() => { onPick(u); }}>Add</Button>
          </li>
        ))}
      </ul>
      {found.hasNextPage && !found.isError && <Button disabled={found.isFetchingNextPage} onClick={() => void found.fetchNextPage()}>Show more</Button>}
    </div>
  );
}
