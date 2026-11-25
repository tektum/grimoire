import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { components } from '@tektum/grimoire-api-client';
import { type FormEvent, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { type ApiLike, queryKey } from '../../api/query';
import { HttpError } from '../../tree/useTree';
import { focusWhenReady } from '../../ui/focus';
import { Button, Confirm } from '../../ui/primitives';
import { GroupMembers } from './GroupMembers';
import './admin.css';

type Group = Readonly<components['schemas']['Group']>;
const GROUPS_PATH = '/v1/groups';
const groupsKey = queryKey('GET', GROUPS_PATH, undefined);

/** The groups: make, rename and delete them, and open one to see and change its members (R6.46, R6.47, R6.48). The group opened is in the address (`?group=`). */
export function GroupsScreen({ api }: { readonly api: ApiLike }) {
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const open = params.get('group');
  const [name, setName] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Group | null>(null);
  const groups = useQuery<readonly Group[], HttpError>({
    queryKey: groupsKey,
    queryFn: async ({ signal }) => {
      const { data, response } = await api.GET(GROUPS_PATH as never, { signal } as never);
      if (!response.ok) throw new HttpError(response.status);
      return (data as { items: readonly Group[] }).items;
    },
  });

  /** One change; the list is read again whatever the answer, so a refusal (worded by the API wrapper) leaves what the server has. */
  const run = async (call: () => Promise<{ response: Response }>): Promise<boolean> => {
    try {
      return (await call()).response.ok;
    } catch {
      return false; // the network failed: the wrapper has said so
    } finally {
      await client.invalidateQueries({ queryKey: groupsKey });
    }
  };

  const create = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const wanted = name.trim();
    if (wanted === '') return;
    if (await run(() => api.POST(GROUPS_PATH as never, { body: { name: wanted } } as never))) setName('');
  };
  const rename = async (group: Group, to: string): Promise<void> => {
    setRenaming(null);
    if (to.trim() !== '' && to.trim() !== group.name) await run(() => api.PATCH('/v1/groups/{id}' as never, { params: { path: { id: group.id } }, body: { name: to.trim() } } as never));
  };
  const remove = async (group: Group): Promise<void> => {
    if (await run(() => api.DELETE('/v1/groups/{id}' as never, { params: { path: { id: group.id } } } as never)) && open === group.id) setParams({});
  };
  const chosen = groups.data?.find((g) => g.id === open);

  return (
    <section aria-labelledby="screen-title" className="admin-screen">
      <h1 id="screen-title">Groups</h1>
      <form onSubmit={(e) => void create(e)} className="admin-search">
        <input aria-label="New group name" placeholder="New group name" maxLength={100} value={name} onChange={(e) => { setName(e.target.value); }} />
        <Button type="submit">Create group</Button>
      </form>
      {groups.isError && groups.data === undefined ? (
        <p role="alert">
          Couldn&apos;t load the groups. <Button onClick={() => void groups.refetch()}>Try again</Button>
        </p>
      ) : groups.data === undefined ? (
        <p>Loading</p>
      ) : groups.data.length === 0 ? (
        <p>No groups yet</p>
      ) : (
        <ul className="admin-list">
          {groups.data.map((g) => (
            <li key={g.id}>
              <div className="admin-main">
                {renaming === g.id ? (
                  <input
                    aria-label={`New name for ${g.name}`}
                    defaultValue={g.name}
                    maxLength={100}
                    ref={focusWhenReady}
                    onFocus={(e) => { e.currentTarget.select(); }}
                    onBlur={() => { setRenaming(null); }}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') setRenaming(null);
                      if (e.key === 'Enter') void rename(g, e.currentTarget.value);
                    }}
                  />
                ) : (
                  <Link to={`?group=${g.id}`} {...(g.id === open ? { 'aria-current': 'true' as const } : {})}>{g.name}</Link>
                )}
                <span className="admin-meta">{g.memberCount === 1 ? '1 member' : `${String(g.memberCount)} members`}</span>
              </div>
              <Button aria-label={`Rename ${g.name}`} onClick={() => { setRenaming(g.id); }}>Rename</Button>
              <Button aria-label={`Delete ${g.name}`} onClick={() => { setDeleting(g); }}>Delete</Button>
            </li>
          ))}
        </ul>
      )}
      {chosen !== undefined && <GroupMembers key={chosen.id} api={api} group={chosen} />}
      {deleting !== null && (
        <Confirm
          title={`Delete the group ${deleting.name}?`}
          description="Its members stay, and lose the access the group gave them."
          confirmLabel="Delete group"
          open
          onOpenChange={(isOpen) => { if (!isOpen) setDeleting(null); }}
          onConfirm={() => { const group = deleting; setDeleting(null); void remove(group); }}
        />
      )}
    </section>
  );
}
