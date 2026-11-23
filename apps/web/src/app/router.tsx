import { lazy, Suspense } from 'react';
import { createBrowserRouter, type RouteObject } from 'react-router';
import { ROUTES } from './routes';
import { Shell } from './Shell';

const screens: Record<string, ReturnType<typeof lazy>> = {
  login: lazy(() => import('../screens/login')),
  collections: lazy(() => import('../screens/collections')),
  page: lazy(() => import('../screens/page')),
  history: lazy(() => import('../screens/history')),
  search: lazy(() => import('../screens/search')),
  trash: lazy(() => import('../screens/trash')),
  import: lazy(() => import('../screens/import')),
  admin: lazy(() => import('../screens/admin')),
  notfound: lazy(() => import('../screens/notfound')),
};

const SamplePage = lazy(() => import('../ui/SamplePage'));
/** The sample content page exists in development and test builds only; `__GRIMOIRE_DEV_SIGNIN__` is false in production, so the page is not in any production chunk. */
const withSample = typeof __GRIMOIRE_DEV_SIGNIN__ !== 'undefined' && __GRIMOIRE_DEV_SIGNIN__;

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
  const sample: RouteObject[] = withSample
    ? [
        {
          path: '/design-sample',
          element: (
            <Suspense fallback={null}>
              <SamplePage />
            </Suspense>
          ),
        },
      ]
    : [];
  return [{ path: '/', element: <Shell />, children: [{ index: true, element: <p>Opening your last collection</p> }, ...sample, ...children] }];
}

export const createAppRouter = () => createBrowserRouter(routeObjects());
