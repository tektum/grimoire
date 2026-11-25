import { Link } from 'react-router';
import { type ApiLike, useApiQuery } from '../../api/query';
import './collections.css';

/** An empty workspace: an administrator can make the first collection from here, anyone else is told whom to ask. Nothing more is said until it is known who is asking. */
export function NoCollections({ api }: { readonly api: ApiLike }) {
  const me = useApiQuery<{ role: 'admin' | 'member' | 'viewer' }>(api, '/v1/me');
  return (
    <>
      <p>No collections yet</p>
      {me.data?.role === 'admin' ? (
        <Link to="/collections/new" className="button" data-variant="primary">
          New collection
        </Link>
      ) : (
        me.data !== undefined && <p>Ask an admin to create one.</p>
      )}
    </>
  );
}
