import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { type ApiLike, queryKey } from '../../api/query';
import { Button } from '../../ui/primitives';
import { Tree } from '../../tree/Tree';
import { buildTree } from '../../tree/model';
import { HttpError, useCollectionTree } from '../../tree/useTree';
import NotFoundScreen from '../notfound';
import './collections.css';

interface CollectionItem {
  readonly id: string;
  readonly name: string;
  readonly icon: string | null;
  readonly myPermission: 'read-write' | 'read-only';
}

const LIST_PATH = '/v1/collections';

function useCollections(api: ApiLike) {
  return useQuery<readonly CollectionItem[], HttpError>({
    queryKey: queryKey('GET', LIST_PATH, undefined),
    queryFn: async ({ signal }) => {
      const { data, response } = await api.GET(LIST_PATH as never, { signal } as never);
      if (!response.ok) throw new HttpError(response.status);
      return (data as { items: readonly CollectionItem[] }).items;
    },
  });
}

/** A read that answers 404 or 403 is "not found" to the user, whichever it was (R11.15). */
const isNotFound = (error: HttpError | null): boolean => error !== null && (error.status === 404 || error.status === 403);

/** The collection list beside the contents tree of the open collection. Content is never read here, so nothing in it is kept in the query cache. */
export function CollectionsScreen({ api, collectionId }: { readonly api: ApiLike; readonly collectionId: string }) {
  const collections = useCollections(api);
  const tree = useCollectionTree(api, collectionId);
  const current = collections.data?.find((c) => c.id === collectionId);
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
            {tree.isError ? (
              <p role="alert">
                Couldn&apos;t load the pages. <Button onClick={() => void tree.refetch()}>Try again</Button>
              </p>
            ) : tree.data === undefined ? (
              <p>Loading</p>
            ) : (
              <Tree items={buildTree(tree.data)} />
            )}
          </>
        )}
      </section>
    </div>
  );
}
