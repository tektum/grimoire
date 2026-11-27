import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { type RefObject, useMemo, useRef } from 'react';
import { Link, useLocation, useMatch, useNavigate } from 'react-router';
import { urlIdOf } from '../app/routes';
import { type ApiLike, queryKey } from '../api/query';
import { LAST_COLLECTION_KEY, useCollections } from '../screens/collections/useCollections';
import { type ClientStorage, createClientStorage } from '../storage';
import { openPalette, shortcutHint } from '../palette/open';
import { Button } from '../ui/primitives';
import { type TreeActions, useTreeActions } from './actions';
import { buildTree, pagePath } from './model';
import { Tree } from './Tree';
import { HttpError, useCollectionTree } from './useTree';
import './tree.css';

const PAGE_PATH = '/v1/pages/by-url-id/{urlId}';

/** The collection a page is in, from the address of the page (the page screen reads the same page, under the same key). */
function usePageCollection(api: ApiLike, urlId: string | undefined): { readonly collectionId: string | undefined; readonly pending: boolean } {
  const page = useQuery<{ collectionId: string }, HttpError>({
    enabled: urlId !== undefined,
    queryKey: queryKey('GET', PAGE_PATH, { params: { path: { urlId } } }),
    queryFn: async ({ signal }) => {
      const { data, response } = await api.GET(PAGE_PATH as never, { params: { path: { urlId } }, signal } as never);
      if (!response.ok) throw new HttpError(response.status);
      return data as { collectionId: string };
    },
  });
  return { collectionId: page.data?.collectionId, pending: urlId !== undefined && page.isPending };
}

function CollectionContents({ api, collectionId, currentUrlId, hereKey }: { readonly hereKey: RefObject<string>; readonly api: ApiLike; readonly collectionId: string; readonly currentUrlId: string | undefined }) {
  const collections = useCollections(api);
  const tree = useCollectionTree(api, collectionId);
  const navigate = useNavigate();
  const plain = useTreeActions(api, collectionId);
  // A new page is opened, with its title field ready and empty (the page screen reads `newPage`): a title is what a person gives a page first.
  const actions = useMemo<TreeActions>(
    () => ({
      ...plain,
      create: (parentId) => {
        // The page that was made is opened only if the person is still where they pressed the button (the key of the location): they may have gone elsewhere meanwhile. It is opened as soon as the
        // server has answered, not when the tree has been read again afterwards: that read can end late, and by then the person may be renaming a row of this very tree, which opening the page
        // would take from under them (the title field is gone with the tree).
        const pressedAt = hereKey.current;
        return plain.create(parentId, (page) => {
          if (hereKey.current === pressedAt) navigate(pagePath(page.title, page.urlId), { state: { newPage: true } });
        });
      },
    }),
    [plain, navigate, hereKey],
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
      {writable && (
        <div className="contents-foot">
          <Button onClick={() => void actions.create(null)}>New page</Button>
        </div>
      )}
    </>
  );
}

/**
 * The contents beside every screen (the shell's contents area): the tree of the collection that is open (`/c/:id`), the one of the page that is open
 * (`/p/:slug`, read through the page's address), or else the collection that was read last. Nothing but its name where there is none.
 */
/** The collection the person is in: the one in the address (`/c/:id`), the one of the page that is open, or else the one read last; with the `urlId` of the open page, if any. */
export function useOpenCollection(api: ApiLike, storage?: ClientStorage): { readonly collectionId: string | undefined; readonly urlId: string | undefined; readonly pending: boolean } {
  const inCollection = useMatch('/c/:collectionId');
  const inPage = useMatch('/p/:slug/*');
  const urlId = inPage?.params.slug === undefined ? undefined : urlIdOf(inPage.params.slug);
  const remembered = useMemo(() => storage ?? createClientStorage(), [storage]);
  const ofPage = usePageCollection(api, urlId);
  return { collectionId: inCollection?.params.collectionId ?? (urlId === undefined ? (remembered.get(LAST_COLLECTION_KEY) ?? undefined) : ofPage.collectionId), urlId, pending: inCollection === null && ofPage.pending };
}

export function ContentsPanel({ api, storage }: { readonly api: ApiLike; readonly storage?: ClientStorage }) {
  const { collectionId: open, urlId, pending } = useOpenCollection(api, storage);
  // The collection whose tree was shown, kept only while the page that is being opened says which collection it is in (not after its lookup failed: a page that is not found or not allowed has no tree of the collection before it): a new page opens from a tree, and a tree that is taken down for that moment takes the
  // row being renamed (and its title field) with it. A page opened with no tree before it has none until its collection is known.
  const shown = useRef<string | undefined>(undefined);
  if (open !== undefined) shown.current = open;
  const collectionId = open ?? (pending ? shown.current : undefined);
  // Kept here, in the part that stays when the screen changes: the key of the location now, for `CollectionContents` to compare with the one where a page was asked for.
  const { key } = useLocation();
  const hereKey = useRef(key);
  hereKey.current = key;
  return (
    <div className="contents">
      <p className="contents-title">Contents</p>
      <button type="button" className="contents-search" aria-keyshortcuts="Control+K Meta+K" onClick={openPalette}>
        <Search aria-hidden size={16} strokeWidth={1.5} />
        <span>Search</span>
        <kbd aria-hidden>{shortcutHint()}</kbd>
      </button>
      {collectionId !== undefined && <CollectionContents api={api} collectionId={collectionId} currentUrlId={urlId} hereKey={hereKey} />}
    </div>
  );
}
