import { lazy, Suspense } from 'react';
import { createBrowserRouter, type RouteObject } from 'react-router';
import { ROUTES } from './routes';
import { Shell } from './Shell';

const screens: Record<string, ReturnType<typeof lazy>> = {
  login: lazy(() => import('../screens/login')),
  collections: lazy(() => import('../screens/collections')),
  'new-collection': lazy(() => import('../screens/collections/NewCollection')),
  page: lazy(() => import('../screens/page')),
  history: lazy(() => import('../screens/history')),
  search: lazy(() => import('../screens/search')),
  trash: lazy(() => import('../screens/trash')),
  import: lazy(() => import('../screens/import')),
  admin: lazy(() => import('../screens/admin')),
  help: lazy(() => import('../screens/help')),
  notfound: lazy(() => import('../screens/notfound')),
};

/** `/`: on to the collection read last (contracts section 3). */
const Home = lazy(() => import('../screens/collections/HomeScreen'));

/** The sample content page exists in development and test builds only. `__GRIMOIRE_DEV_SIGNIN__` is replaced by a constant at build time, so in a production build the `import()` below is dead code and the page is not emitted. */
const SamplePage = typeof __GRIMOIRE_DEV_SIGNIN__ !== 'undefined' && __GRIMOIRE_DEV_SIGNIN__ ? lazy(() => import('../ui/SamplePage')) : null;

export function routeObjects(): RouteObject[] {
  const children = ROUTES.map<RouteObject>((r) => {
    const Screen = screens[r.screen]!;
    return {
      path: r.path,
      element: (
        <Suspense fallback={<p>Loading</p>}>
          <Screen />
        </Suspense>
      ),
    };
  });
  const Sample = SamplePage;
  const sample: RouteObject[] =
    Sample !== null
      ? [
          {
            path: '/design-sample',
            element: (
              <Suspense fallback={null}>
                <Sample />
              </Suspense>
            ),
          },
        ]
      : [];
  return [{ path: '/', element: <Shell />, children: [{ index: true, element: <Suspense fallback={<p>Loading</p>}><Home /></Suspense> }, ...sample, ...children] }];
}

export const createAppRouter = () => createBrowserRouter(routeObjects());
