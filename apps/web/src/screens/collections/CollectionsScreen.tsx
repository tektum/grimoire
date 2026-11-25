import { useEffect } from 'react';
import { Link } from 'react-router';
import { type ApiLike, useApiQuery } from '../../api/query';
import type { ClientStorage } from '../../storage';
import { Button } from '../../ui/primitives';
import type { HttpError } from '../../tree/useTree';
import NotFoundScreen from '../notfound';
import { NoCollections } from './NoCollections';
import { LAST_COLLECTION_KEY, useCollection, useCollections } from './useCollections';
import './collections.css';

/** A read that answers 404 or 403 is "not found" to the user, whichever it was (R11.15). */
const isNotFound = (error: HttpError | null): boolean => error !== null && (error.status === 404 || error.status === 403);

/** The collection list and the name of the open collection; its pages are in the shell's contents (`ContentsPanel`). Content is never read here, so nothing in it is kept in the query cache. */
export function CollectionsScreen({ api, collectionId, storage }: { readonly api: ApiLike; readonly collectionId: string; readonly storage?: ClientStorage }) {
  const collections = useCollections(api);
  const collection = useCollection(api, collectionId);
  const me = useApiQuery<{ role: string }>(api, '/v1/me');
  const current = collection.data ?? collections.data?.find((c) => c.id === collectionId);
  // The collection that was read last is where `/` goes next time (only a collection that could be read counts).
  const readable = collection.data !== undefined;
  useEffect(() => {
    if (readable) storage?.set(LAST_COLLECTION_KEY, collectionId);
  }, [readable, storage, collectionId]);
  return (
    <div className="collections">
      <nav aria-label="Collections" className="collections-list">
        {collections.data?.length === 0 && <NoCollections api={api} />}
        {collections.isError && <p role="alert">Couldn&apos;t load the collections.</p>}
        <ul>
          {collections.data?.map((c) => (
            <li key={c.id}>
              <Link to={`/c/${c.id}`} {...(c.id === collectionId ? { 'aria-current': 'page' as const } : {})}>
                {c.icon !== null && <span aria-hidden>{c.icon}</span>}
                {c.name}
              </Link>
            </li>
          ))}
        </ul>
        {me.data?.role === 'admin' && collections.data !== undefined && collections.data.length > 0 && <Link to="/collections/new">New collection</Link>}
      </nav>
      <section className="collections-tree" aria-labelledby="collection-title">
        {isNotFound(collection.error) ? (
          <NotFoundScreen />
        ) : (
          <>
            <h1 id="collection-title">{current?.name ?? 'Collection'}</h1>
            {me.data?.role === 'admin' && !collection.isError && <Link to={`/admin/collections/${collectionId}/access`}>Manage access</Link>}
            {collection.isError ? (
              <p role="alert">
                Couldn&apos;t load the collection. <Button onClick={() => void collection.refetch()}>Try again</Button>
              </p>
            ) : (
              <p>Choose a page in the contents, or start a new one.</p>
            )}
          </>
        )}
      </section>
    </div>
  );
}
