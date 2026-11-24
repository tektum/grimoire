import { type InfiniteData, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import type { components } from '@tektum/grimoire-api-client';
import { type FormEvent, useState } from 'react';
import { type ApiLike, queryKey } from '../../api/query';
import { HttpError } from '../../tree/useTree';
import { Button, Confirm } from '../../ui/primitives';
import './admin.css';

type AdminUser = Readonly<components['schemas']['AdminUser']>;
type UserList = Readonly<components['schemas']['AdminUserList']>;
type Role = AdminUser['role'];

const ROLES: readonly Role[] = ['admin', 'member', 'viewer'];
const USERS_PATH = '/v1/users';
const usersKey = (q: string): readonly unknown[] => queryKey('GET', USERS_PATH, { params: { query: q === '' ? {} : { q } } });

/** The users: search, role, suspend and reinstate (R6.44, R6.45). A user is never deleted (decision 148): there is no such action. */
export function UsersScreen({ api }: { readonly api: ApiLike }) {
  const client = useQueryClient();
  const [draft, setDraft] = useState('');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [suspending, setSuspending] = useState<AdminUser | null>(null);
  const users = useInfiniteQuery<UserList, HttpError, InfiniteData<UserList, string | null>, readonly unknown[], string | null>({
    queryKey: usersKey(q),
    initialPageParam: null,
    queryFn: async ({ pageParam, signal }) => {
      const query = { ...(q === '' ? {} : { q }), ...(pageParam === null ? {} : { cursor: pageParam }) };
      const { data, response } = await api.GET(USERS_PATH as never, { params: { query }, signal } as never);
      if (!response.ok) throw new HttpError(response.status);
      return data as UserList;
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = users.data?.pages.flatMap((p) => p.items) ?? [];

  /** One change to a user; the list is read again whatever the answer, so a refusal (a 409 the API wrapper has already worded) leaves what the server has. */
  const change = async (id: string, patch: { role?: Role; suspended?: boolean }): Promise<void> => {
    setBusy((s) => new Set(s).add(id));
    try {
      await api.PATCH('/v1/users/{id}' as never, { params: { path: { id } }, body: patch } as never);
    } catch {
      // The network failed: the wrapper has said so.
    } finally {
      // The caller's own role too: an administrator who demoted or suspended themselves must not keep this screen.
      await Promise.all([client.invalidateQueries({ queryKey: queryKey('GET', USERS_PATH, undefined).slice(0, 2) }), client.invalidateQueries({ queryKey: queryKey('GET', '/v1/me', undefined) })]);
      setBusy((s) => { const next = new Set(s); next.delete(id); return next; });
    }
  };

  const search = (event: FormEvent): void => {
    event.preventDefault();
    setQ(draft.trim());
  };

  return (
    <section aria-labelledby="screen-title" className="admin-screen">
      <h1 id="screen-title">Users</h1>
      <form role="search" onSubmit={search} className="admin-search">
        <input type="search" aria-label="Search users" placeholder="Name or email" value={draft} onChange={(e) => { setDraft(e.target.value); }} />
        <Button type="submit">Search</Button>
      </form>
      {users.isError && users.data === undefined ? (
        <p role="alert">
          Couldn&apos;t load the users. <Button onClick={() => void users.refetch()}>Try again</Button>
        </p>
      ) : users.data === undefined ? (
        <p>Loading</p>
      ) : rows.length === 0 ? (
        <p>No users found</p>
      ) : (
        <>
          <ul className="admin-list">
            {rows.map((u) => (
              <li key={u.id}>
                <div className="admin-main">
                  <h2>{u.name}</h2>
                  <span className="admin-meta">{u.email}</span>
                  {u.suspended && <span className="admin-badge">Suspended</span>}
                </div>
                <label className="admin-field">
                  <span aria-hidden>Role</span>
                  <select aria-label={`Role of ${u.name}`} value={u.role} disabled={busy.has(u.id)} onChange={(e) => void change(u.id, { role: e.target.value as Role })}>
                    {ROLES.map((r) => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                </label>
                {u.suspended ? (
                  <Button aria-label={`Reinstate ${u.name}`} disabled={busy.has(u.id)} onClick={() => void change(u.id, { suspended: false })}>Reinstate</Button>
                ) : (
                  <Button aria-label={`Suspend ${u.name}`} disabled={busy.has(u.id)} onClick={() => { setSuspending(u); }}>Suspend</Button>
                )}
              </li>
            ))}
          </ul>
          {users.hasNextPage && <Button disabled={users.isFetchingNextPage} onClick={() => void users.fetchNextPage()}>Show more</Button>}
        </>
      )}
      {suspending !== null && (
        <Confirm
          title={`Suspend ${suspending.name}?`}
          description={`${suspending.name} is refused at once and loses live editing within a minute. You can reinstate them later.`}
          confirmLabel="Suspend"
          open
          onOpenChange={(open) => { if (!open) setSuspending(null); }}
          onConfirm={() => { const id = suspending.id; setSuspending(null); void change(id, { suspended: true }); }}
        />
      )}
    </section>
  );
}
