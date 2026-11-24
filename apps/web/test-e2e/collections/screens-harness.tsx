import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { createMemoryRouter, RouterProvider, useParams } from 'react-router';
import { Shell } from '../../src/app/Shell';
import { SessionContext } from '../../src/auth/session';
import type { ApiLike } from '../../src/api/query';
import { CollectionsScreen } from '../../src/screens/collections/CollectionsScreen';
import NotFoundScreen from '../../src/screens/notfound';
import { TrashScreen } from '../../src/screens/trash/TrashScreen';
import '../../src/ui/global.css';

interface Data {
  readonly collections: readonly unknown[];
  readonly pages: readonly unknown[];
  readonly trash?: readonly unknown[];
}

/** A typed client that answers from memory: the collection list and the tree of any collection. */
const fakeApi = (data: Data): ApiLike => {
  const answer = (path: string, init?: { params?: { path?: { urlId?: string } } }) => {
    const found = path === '/v1/pages/by-url-id/{urlId}' ? (data.pages as { urlId: string }[]).find((p) => p.urlId === init?.params?.path?.urlId) : undefined;
    const body = path === '/v1/me' ? { id: 'u1', name: 'Alice Example', email: 'alice@dev.invalid', role: 'member' } : path === '/v1/collections' ? { items: data.collections } : path === '/v1/trash' ? { items: data.trash ?? [], nextCursor: null } : found !== undefined ? { ...found, collectionId: 'c1' } : { pages: data.pages };
    return Promise.resolve({ data: body, response: new Response(null, { status: 200 }) });
  };
  const none = () => Promise.resolve({ response: new Response(null, { status: 404 }) });
  return { GET: answer, POST: none, PUT: none, PATCH: none, DELETE: none } as unknown as ApiLike;
};

function CollectionRoute({ api }: { api: ApiLike }) {
  const { collectionId } = useParams();
  return <CollectionsScreen api={api} collectionId={collectionId ?? ''} />;
}

/** A page of text where the page screen goes: the editor is another task's, and the contents beside it are what is shown here. */
function PageStandIn({ pages }: { pages: readonly unknown[] }) {
  const { slug } = useParams();
  const page = (pages as { urlId: string; title: string }[]).find((p) => slug?.endsWith(`-${p.urlId}`));
  return (
    <section aria-labelledby="screen-title">
      <h1 id="screen-title">{page?.title ?? 'Page'}</h1>
      <p>Once upon a time there was a page, and beside it a tree that said where it lived.</p>
    </section>
  );
}

function TrashRoute({ api }: { api: ApiLike }) {
  return <TrashScreen api={api} />;
}

/** Bundled by the screenshot spec: the shell with the screen at `path` (`/c/<id>`, `/trash`, anything else is the not-found screen), drawn from the given data. */
(window as unknown as { show: (data: Data, path: string) => void }).show = (data, path) => {
  const api = fakeApi(data);
  const router = createMemoryRouter(
    [{ path: '/', element: <Shell />, children: [{ path: 'c/:collectionId', element: <CollectionRoute api={api} /> }, { path: 'trash', element: <TrashRoute api={api} /> }, { path: 'p/:slug', element: <PageStandIn pages={data.pages} /> }, { path: '*', element: <NotFoundScreen /> }] }],
    { initialEntries: [path] },
  );
  const host = document.getElementById('host');
  if (host === null) throw new Error('no host element');
  createRoot(host).render(
    <SessionContext.Provider value={{ auth: null as never, api }}>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </SessionContext.Provider>,
  );
};
