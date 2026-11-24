import { Link, useMatch } from 'react-router';
import { type ApiLike, useApiQuery } from '../../api/query';
import { Button } from '../../ui/primitives';
import NotFoundScreen from '../notfound';
import { AccessScreen } from './AccessScreen';
import { GroupsScreen } from './GroupsScreen';
import { UsersScreen } from './UsersScreen';

/**
 * The admin screens (R11.3): only for an administrator. Anyone else, and any address under /admin that is not a screen, gets the not-found screen, and
 * no admin request is made before it is known that the person is an administrator.
 */
export function AdminArea({ api }: { readonly api: ApiLike }) {
  const me = useApiQuery<{ role: 'admin' | 'member' | 'viewer' }>(api, '/v1/me');
  const users = useMatch('/admin/users');
  const groups = useMatch('/admin/groups');
  const access = useMatch('/admin/collections/:id/access');
  if (me.isError && me.data === undefined) {
    return (
      <p role="alert">
        Couldn&apos;t check who you are. <Button onClick={() => void me.refetch()}>Try again</Button>
      </p>
    );
  }
  if (me.data === undefined) return <p>Loading</p>;
  if (me.data.role !== 'admin' || (users === null && groups === null && access === null)) return <NotFoundScreen />;
  return (
    <>
      <nav aria-label="Admin" className="admin-nav">
        <Link to="/admin/users" {...(users !== null ? { 'aria-current': 'page' as const } : {})}>Users</Link>
        <Link to="/admin/groups" {...(groups !== null ? { 'aria-current': 'page' as const } : {})}>Groups</Link>
      </nav>
      {users !== null ? <UsersScreen api={api} /> : groups !== null ? <GroupsScreen api={api} /> : <AccessScreen api={api} />}
    </>
  );
}
