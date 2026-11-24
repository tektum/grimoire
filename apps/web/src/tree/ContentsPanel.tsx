import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { Link, useMatch, useNavigate } from 'react-router';
import { urlIdOf } from '../app/routes';
import { type ApiLike, queryKey } from '../api/query';
import { LAST_COLLECTION_KEY, useCollections } from '../screens/collections/useCollections';
import { type ClientStorage, createClientStorage } from '../storage';
import { Button } from '../ui/primitives';
import { type TreeActions, useTreeActions } from './actions';
import { buildTree, type FlatPage, pagePath } from './model';
import { Tree } from './Tree';
import { HttpError, useCollectionTree } from './useTree';
import './tree.css';

const PAGE_PATH = '/v1/pages/by-url-id/{urlId}';

/** The collection a page is in, from the address of the page (the page screen reads the same page, under the same key). */
function usePageCollection(api: ApiLike, urlId: string | undefined): string | undefined {
  const page = useQuery<{ collectionId: string }, HttpError>({
    enabled: urlId !== undefined,
    queryKey: queryKey('GET', PAGE_PATH, { params: { path: { urlId } } }),
    queryFn: async ({ signal }) => {
      const { data, response } = await api.GET(PAGE_PATH as never, { params: { path: { urlId } }, signal } as never);
      if (!response.ok) throw new HttpError(response.status);
      return data as { collectionId: string };
    },
  });
  return page.data?.collectionId;
}

function CollectionContents({ api, collectionId, currentUrlId }: { readonly api: ApiLike; readonly collectionId: string; readonly currentUrlId: string | undefined }) {
  const collections = useCollections(api);
  const tree = useCollectionTree(api, collectionId);
  const navigate = useNavigate();
  const plain = useTreeActions(api, collectionId);
  // A new page is opened, with its title field ready and empty (the page screen reads `newPage`): a title is what a person gives a page first.
  const actions = useMemo<TreeActions>(
    () => ({
      ...plain,
      create: async (parentId) => {
        const outcome = await plain.create(parentId);
        if (outcome.ok) {
          const page = outcome.data as FlatPage;
          navigate(pagePath(page.title, page.urlId), { state: { newPage: true } });
        }
        return outcome;
      },
    }),
    [plain, navigate],
  );
  const items = useMemo(() => buildTree(tree.data ?? []), [tree.data]);
  const current = collections.data?.find((c) => c.id === collectionId);
  const writable = current?.myPermission === 'read-write';
  // A collection that cannot be read is the main screen's not-found; the panel has nothing to show for it.
  if (tree.error?.status === 404 || tree.error?.status === 403) return null;
  return (
    <>
      <div className="contents-head">
        <Link to={`/c/${collectionId}`} className="contents-collection">
          {current?.name ?? 'Collection'}
        </Link>
        {writable && <Button variant="primary" onClick={() => void actions.create(null)}>New page</Button>}
      </div>
      {tree.isError && tree.data === undefined ? (
        <p role="alert">
          Couldn&apos;t load the pages. <Button onClick={() => void tree.refetch()}>Try again</Button>
        </p>
      ) : tree.data === undefined ? (
        <p>Loading</p>
      ) : (
        <Tree items={items} currentUrlId={currentUrlId} editing={writable ? { actions, pages: tree.data } : undefined} />
      )}
    </>
  );
}

/**
 * The contents beside every screen (the shell's contents area): the tree of the collection that is open (`/c/:id`), the one of the page that is open
 * (`/p/:slug`, read through the page's address), or else the collection that was read last. Nothing but its name where there is none.
 */
export function ContentsPanel({ api, storage }: { readonly api: ApiLike; readonly storage?: ClientStorage }) {
  const inCollection = useMatch('/c/:collectionId');
  const inPage = useMatch('/p/:slug/*');
  const urlId = inPage?.params.slug === undefined ? undefined : urlIdOf(inPage.params.slug);
  const remembered = useMemo(() => storage ?? createClientStorage(), [storage]);
  const ofPage = usePageCollection(api, urlId);
  const collectionId = inCollection?.params.collectionId ?? (urlId === undefined ? (remembered.get(LAST_COLLECTION_KEY) ?? undefined) : ofPage);
  return (
    <div className="contents">
      <p className="contents-title">Contents</p>
      {collectionId !== undefined && <CollectionContents api={api} collectionId={collectionId} currentUrlId={urlId} />}
    </div>
  );
}
