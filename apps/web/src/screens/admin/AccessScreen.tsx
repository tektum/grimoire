import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { components } from '@tektum/grimoire-api-client';
import { useState } from 'react';
import { useParams } from 'react-router';
import { type ApiLike, queryKey } from '../../api/query';
import { HttpError } from '../../tree/useTree';
import { Button, Confirm } from '../../ui/primitives';
import { useCollection } from '../collections/useCollections';
import NotFoundScreen from '../notfound';
import { UserPicker } from './UserPicker';
import './admin.css';

type Access = Readonly<components['schemas']['CollectionAccess']>;
type Entry = Readonly<components['schemas']['CollectionAccessEntry']>;
type Group = Readonly<components['schemas']['Group']>;
type Permission = Entry['permission'];

const PERMISSIONS: readonly { value: Permission; label: string }[] = [
  { value: 'read', label: 'read' },
  { value: 'read_write', label: 'read and write' },
];
const accessKey = (id: string): readonly unknown[] => queryKey('GET', '/v1/collections/{id}/access', { params: { path: { id } } });

/** Who may read and write a collection (R6.18, R6.19, R6.20): the default for everyone, and entries for single people and groups. */
export function AccessScreen({ api }: { readonly api: ApiLike }) {
  const { id: collectionId = '' } = useParams();
  const client = useQueryClient();
  const collection = useCollection(api, collectionId);
  const [kind, setKind] = useState<'user' | 'group'>('user');
  const [permission, setPermission] = useState<Permission>('read');
  const [group, setGroup] = useState('');
  const [removing, setRemoving] = useState<Entry | null>(null);
  const access = useQuery<Access, HttpError>({
    queryKey: accessKey(collectionId),
    queryFn: async ({ signal }) => {
      const { data, response } = await api.GET('/v1/collections/{id}/access' as never, { params: { path: { id: collectionId } }, signal } as never);
      if (!response.ok) throw new HttpError(response.status);
      return data as Access;
    },
  });
  const groups = useQuery<readonly Group[], HttpError>({
    enabled: kind === 'group',
    queryKey: queryKey('GET', '/v1/groups', undefined),
    queryFn: async ({ signal }) => {
      const { data, response } = await api.GET('/v1/groups' as never, { signal } as never);
      if (!response.ok) throw new HttpError(response.status);
      return (data as { items: readonly Group[] }).items;
    },
  });

  /** One change; the access is read again whatever the answer, so a refusal (worded by the API wrapper) leaves what the server has. */
  const change = async (call: () => Promise<unknown>): Promise<void> => {
    try {
      await call();
    } catch {
      // The network failed: the wrapper has said so.
    } finally {
      await client.invalidateQueries({ queryKey: accessKey(collectionId) });
    }
  };
  const grant = (principalType: 'user' | 'group', principalId: string, to: Permission): Promise<void> =>
    change(() => api.PUT('/v1/collections/{id}/access' as never, { params: { path: { id: collectionId } }, body: { principalType, principalId, permission: to } } as never));

  if (collection.error?.status === 404 || collection.error?.status === 403) return <NotFoundScreen />;
  const entries = access.data?.entries ?? [];
  const taken = new Set(entries.filter((e) => e.principalType === 'group').map((e) => e.principalId));
  const takenUsers = new Set(entries.filter((e) => e.principalType === 'user').map((e) => e.principalId));
  const name = collection.data?.name ?? 'the collection';

  return (
    <section aria-labelledby="screen-title" className="admin-screen">
      <h1 id="screen-title">Access to {name}</h1>
      {access.isError && access.data === undefined ? (
        <p role="alert">
          Couldn&apos;t load the access. <Button onClick={() => void access.refetch()}>Try again</Button>
        </p>
      ) : access.data === undefined ? (
        <p>Loading</p>
      ) : (
        <>
          <label className="admin-field">
            <span>Everyone with an account can</span>
            <select
              aria-label="Everyone with an account can"
              value={access.data.defaultPermission ?? 'none'}
              onChange={(e) =>
                void change(() => api.PATCH('/v1/collections/{id}' as never, { params: { path: { id: collectionId } }, body: { defaultPermission: e.target.value === 'none' ? null : e.target.value } } as never))
              }
            >
              <option value="none">do nothing here</option>
              {PERMISSIONS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          {entries.length === 0 ? (
            <p>No one has been given access one by one</p>
          ) : (
            <div className="admin-scroll" role="region" aria-label="Access list" tabIndex={0}>
              <table aria-label="Who has access" className="admin-table" role="table">
                <thead>
                  <tr role="row">
                    <th scope="col">Name</th>
                    <th scope="col">Type</th>
                    <th scope="col">Can</th>
                    <th scope="col">
                      <span className="admin-hidden">Remove</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => (
                    <tr key={e.id} role="row">
                      <td role="cell" data-label="Name">{e.name}</td>
                      <td role="cell" data-label="Type">{e.principalType === 'group' ? 'Group' : 'User'}</td>
                      <td role="cell" data-label="Can">
                        <select aria-label={`What ${e.name} can do`} value={e.permission} onChange={(ev) => void grant(e.principalType, e.principalId, ev.target.value as Permission)}>
                          {PERMISSIONS.map((p) => (
                            <option key={p.value} value={p.value}>
                              {p.label}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td role="cell" data-label="Remove">
                        <Button
                          aria-label={`Remove ${e.name}`}
                          onClick={() => {
                            setRemoving(e);
                          }}
                        >
                          Remove
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <h2>Give access</h2>
          <div className="admin-form">
            <label className="admin-field">
              <span>Give access to</span>
              <select
                aria-label="Give access to"
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value as 'user' | 'group');
                }}
              >
                <option value="user">a person</option>
                <option value="group">a group</option>
              </select>
            </label>
            <label className="admin-field">
              <span>Permission</span>
              <select
                aria-label="Permission"
                value={permission}
                onChange={(e) => {
                  setPermission(e.target.value as Permission);
                }}
              >
                {PERMISSIONS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {kind === 'user' ? (
            <UserPicker api={api} label="Find a person" exclude={takenUsers} actionLabel={(n) => `Give ${n} access`} onPick={(u) => void grant('user', u.id, permission)} />
          ) : groups.isError && groups.data === undefined ? (
            <p role="alert">
              Couldn&apos;t load the groups. <Button onClick={() => void groups.refetch()}>Try again</Button>
            </p>
          ) : groups.data !== undefined && groups.data.every((g) => taken.has(g.id)) ? (
            <p>No group to give access to</p>
          ) : (
            <div className="admin-form">
              <label className="admin-field">
                <span>Group</span>
                <select
                  aria-label="Group"
                  value={group}
                  onChange={(e) => {
                    setGroup(e.target.value);
                  }}
                >
                  <option value="">choose a group</option>
                  {(groups.data ?? [])
                    .filter((g) => !taken.has(g.id))
                    .map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                </select>
              </label>
              <Button
                disabled={group === '' || taken.has(group)}
                onClick={() => {
                  const chosen = group;
                  setGroup('');
                  void grant('group', chosen, permission);
                }}
              >
                Give access
              </Button>
            </div>
          )}
        </>
      )}
      {removing !== null && (
        <Confirm
          title={`Remove ${removing.name} from ${name}?`}
          description={`${removing.name} keeps no access to ${name} through this entry.`}
          confirmLabel="Remove"
          open
          onOpenChange={(open) => {
            if (!open) setRemoving(null);
          }}
          onConfirm={() => {
            const entry = removing;
            setRemoving(null);
            void change(() => api.DELETE('/v1/collections/{id}/access/{entryId}' as never, { params: { path: { id: collectionId, entryId: entry.id } } } as never));
          }}
        />
      )}
    </section>
  );
}
