import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { components } from '@tektum/grimoire-api-client';
import { type ApiLike, queryKey } from '../../api/query';
import { HttpError } from '../../tree/useTree';
import { Button } from '../../ui/primitives';
import { UserPicker } from './UserPicker';

type Group = Readonly<components['schemas']['Group']>;
type AdminUser = Readonly<components['schemas']['AdminUser']>;

/** The members of one group (R6.48): who is in it, remove one, add one found by search. */
export function GroupMembers({ api, group }: { readonly api: ApiLike; readonly group: Group }) {
  const client = useQueryClient();
  const key = queryKey('GET', '/v1/groups/{id}/members', { params: { path: { id: group.id } } });
  const members = useQuery<readonly AdminUser[], HttpError>({
    queryKey: key,
    queryFn: async ({ signal }) => {
      const { data, response } = await api.GET('/v1/groups/{id}/members' as never, { params: { path: { id: group.id } }, signal } as never);
      if (!response.ok) throw new HttpError(response.status);
      return (data as { items: readonly AdminUser[] }).items;
    },
  });
  /** One change; the members and the groups' counts are read again whatever the answer. */
  const change = async (call: () => Promise<unknown>): Promise<void> => {
    try {
      await call();
    } catch {
      // The network failed: the wrapper has said so.
    } finally {
      await Promise.all([client.invalidateQueries({ queryKey: key }), client.invalidateQueries({ queryKey: queryKey('GET', '/v1/groups', undefined) })]);
    }
  };
  const path = (userId: string) => ({ params: { path: { id: group.id, userId } } });
  return (
    <section aria-labelledby="members-title" className="admin-members">
      <h2 id="members-title">Members of {group.name}</h2>
      {members.isError && members.data === undefined ? (
        <p role="alert">
          Couldn&apos;t load the members. <Button onClick={() => void members.refetch()}>Try again</Button>
        </p>
      ) : members.data === undefined ? (
        <p>Loading</p>
      ) : members.data.length === 0 ? (
        <p>No members yet</p>
      ) : (
        <ul className="admin-list" aria-label="Members">
          {members.data.map((u) => (
            <li key={u.id}>
              <div className="admin-main">
                <h3>{u.name}</h3>
                <span className="admin-meta">{u.email}</span>
              </div>
              <Button aria-label={`Remove ${u.name} from ${group.name}`} onClick={() => void change(() => api.DELETE('/v1/groups/{id}/members/{userId}' as never, path(u.id) as never))}>Remove</Button>
            </li>
          ))}
        </ul>
      )}
      <UserPicker
        api={api}
        label="Find a person to add"
        exclude={new Set((members.data ?? []).map((u) => u.id))}
        actionLabel={(name) => `Add ${name} to ${group.name}`}
        onPick={(u) => void change(() => api.PUT('/v1/groups/{id}/members/{userId}' as never, path(u.id) as never))}
      />
    </section>
  );
}
