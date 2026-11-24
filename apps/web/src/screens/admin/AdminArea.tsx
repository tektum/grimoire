import { useMatch } from 'react-router';
import { type ApiLike, useApiQuery } from '../../api/query';
import { Button } from '../../ui/primitives';
import NotFoundScreen from '../notfound';
import { UsersScreen } from './UsersScreen';

/**
 * The admin screens (R11.3): only for an administrator. Anyone else, and any address under /admin that is not a screen, gets the not-found screen, and
 * no admin request is made before it is known that the person is an administrator.
 */
export function AdminArea({ api }: { readonly api: ApiLike }) {
  const me = useApiQuery<{ role: 'admin' | 'member' | 'viewer' }>(api, '/v1/me');
  const users = useMatch('/admin/users');
  if (me.isError && me.data === undefined) {
    return (
      <p role="alert">
        Couldn&apos;t check who you are. <Button onClick={() => void me.refetch()}>Try again</Button>
      </p>
    );
  }
  if (me.data === undefined) return <p>Loading</p>;
  if (me.data.role !== 'admin' || users === null) return <NotFoundScreen />;
  return <UsersScreen api={api} />;
}
