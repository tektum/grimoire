import { useEffect, useMemo } from 'react';
import { Link } from 'react-router';
import type { ApiLike } from '../../api/query';
import type { ClientStorage } from '../../storage';
import { Button } from '../../ui/primitives';
import { Tree } from '../../tree/Tree';
import { buildTree } from '../../tree/model';
import type { HttpError } from '../../tree/useTree';
import { useCollectionTree } from '../../tree/useTree';
import NotFoundScreen from '../notfound';
import { LAST_COLLECTION_KEY, useCollections } from './useCollections';
import './collections.css';

/** A read that answers 404 or 403 is "not found" to the user, whichever it was (R11.15). */
const isNotFound = (error: HttpError | null): boolean => error !== null && (error.status === 404 || error.status === 403);

/** The collection list beside the contents tree of the open collection. Content is never read here, so nothing in it is kept in the query cache. */
export function CollectionsScreen({ api, collectionId, storage }: { readonly api: ApiLike; readonly collectionId: string; readonly storage?: ClientStorage }) {
  const collections = useCollections(api);
  const tree = useCollectionTree(api, collectionId);
  const current = collections.data?.find((c) => c.id === collectionId);
  // The collection that was read last is where `/` goes next time (only a collection that could be read counts).
  const readable = tree.data !== undefined;
  useEffect(() => { if (readable) storage?.set(LAST_COLLECTION_KEY, collectionId); }, [readable, storage, collectionId]);
  const items = useMemo(() => buildTree(tree.data ?? []), [tree.data]);
  return (
    <div className="collections">
      <nav aria-label="Collections" className="collections-list">
        {collections.data?.length === 0 && <p>No collections yet</p>}
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
      </nav>
      <section className="collections-tree" aria-labelledby="collection-title">
        {isNotFound(tree.error) ? (
          <NotFoundScreen />
        ) : (
          <>
            <h1 id="collection-title">{current?.name ?? 'Collection'}</h1>
            {tree.isError && tree.data === undefined ? (
              <p role="alert">
                Couldn&apos;t load the pages. <Button onClick={() => void tree.refetch()}>Try again</Button>
              </p>
            ) : tree.data === undefined ? (
              <p>Loading</p>
            ) : (
              <Tree items={items} />
            )}
          </>
        )}
      </section>
    </div>
  );
}
