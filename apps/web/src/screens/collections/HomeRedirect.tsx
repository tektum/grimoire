import { Navigate } from 'react-router';
import type { ApiLike } from '../../api/query';
import type { ClientStorage } from '../../storage';
import { Button } from '../../ui/primitives';
import { LAST_COLLECTION_KEY, useCollections } from './useCollections';

/** `/`: on to the collection that was read last, or the first one when there is none or it can no longer be read. */
export function HomeRedirect({ api, storage }: { readonly api: ApiLike; readonly storage: ClientStorage }) {
  const collections = useCollections(api);
  if (collections.isError) {
    return (
      <p role="alert">
        Couldn&apos;t load the collections. <Button onClick={() => void collections.refetch()}>Try again</Button>
      </p>
    );
  }
  if (collections.data === undefined) return <p>Opening your last collection</p>;
  const last = storage.get(LAST_COLLECTION_KEY);
  const target = collections.data.find((c) => c.id === last) ?? collections.data[0];
  if (target === undefined) return <p>No collections yet</p>;
  return <Navigate to={`/c/${target.id}`} replace />;
}
