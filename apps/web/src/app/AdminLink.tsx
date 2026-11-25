import { Link } from 'react-router';
import { useApiQuery } from '../api/query';
import { useSession } from '../auth/session';

/** The way into the workspace's people and groups, for an administrator only: the palette has it too, but a phone has no keyboard for it. Nothing until the person is known to be one. */
export function AdminLink() {
  const session = useSession();
  return session === null ? null : <Inner api={session.api} />;
}

function Inner({ api }: { api: NonNullable<ReturnType<typeof useSession>>['api'] }) {
  const me = useApiQuery<{ role?: 'admin' | 'member' | 'viewer' }>(api, '/v1/me');
  return me.data?.role === 'admin' ? <Link to="/admin/users">Admin</Link> : null;
}
