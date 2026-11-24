import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { RouterProvider } from 'react-router';
import { createWebApi } from '../api/client';
import type { ApiLike } from '../api/query';
import { type Auth, createAuth, type DescopeModule } from '../auth';
import type { DevSignIn } from '../auth/dev-signin';
import { RequireSignIn } from '../auth/RequireSignIn';
import { SessionContext } from '../auth/session';
import type { WebConfig } from '../config';
import { Gate } from '../gate/Gate';
import type { ServerConfig } from '../gate/config';
import { blockWhenOutdated, guardedFetch, markClientOutdated } from '../gate/outdated';
import type { ClientStorage } from '../storage';
import { notify, Toaster } from '../ui/primitives';
import { ErrorBoundary } from './ErrorBoundary';

export interface AppProps {
  /** Reads `./config.json`. */
  readonly loadConfig: () => Promise<WebConfig>;
  readonly storage: ClientStorage;
  /** The identity provider's SDK, loaded on demand. */
  readonly loadDescope: () => Promise<DescopeModule>;
  /** The development sign-in, or null in a production build (it is imported behind the build define). */
  readonly loadDevSignIn: ((apiUrl: string, storage: ClientStorage) => Promise<DevSignIn>) | null;
  readonly router: () => React.ComponentProps<typeof RouterProvider>['router'];
  /** The page being shown (path and query), for the return address. */
  readonly here: () => string;
  readonly redirect: (url: string) => void;
  readonly fetch?: (request: Request) => Promise<Response>;
}

/** The application: settings, the configuration gate, the session and the API client, the sign-in requirement, then the routes. */
export function App(props: AppProps): ReactNode {
  const [web, setWeb] = useState<WebConfig | 'failed' | null>(null);
  useEffect(() => {
    let live = true;
    props.loadConfig().then(
      (loaded) => live && setWeb(loaded),
      () => live && setWeb('failed'),
    );
    return () => {
      live = false;
    };
  }, []);
  return (
    <ErrorBoundary>
      {web === null ? null : web === 'failed' ? (
        <main className="gate" role="alert">
          <p>The settings of this page could not be read. Reload the page, or tell whoever runs this server.</p>
        </main>
      ) : (
        <Gate options={{ apiUrl: web.apiUrl }}>{(config) => <Session props={props} apiUrl={web.apiUrl} config={config} hiddenDisconnectMs={web.hiddenDisconnectMs} />}</Gate>
      )}
    </ErrorBoundary>
  );
}

function Session({ props, apiUrl, config, hiddenDisconnectMs }: { props: AppProps; apiUrl: string; config: ServerConfig; hiddenDisconnectMs: number }) {
  const [devSignIn, setDevSignIn] = useState<DevSignIn | null | undefined>(props.loadDevSignIn === null || !config.local ? null : undefined);
  useEffect(() => {
    if (devSignIn !== undefined || props.loadDevSignIn === null) return;
    let live = true;
    props.loadDevSignIn(apiUrl, props.storage).then(
      (loaded) => live && setDevSignIn(loaded),
      () => live && setDevSignIn(null),
    );
    return () => {
      live = false;
    };
  }, [devSignIn, apiUrl, props]);
  if (devSignIn === undefined) return null;
  return <Running props={props} apiUrl={apiUrl} config={config} devSignIn={devSignIn} hiddenDisconnectMs={hiddenDisconnectMs} />;
}

function Running({ props, apiUrl, config, devSignIn, hiddenDisconnectMs }: { props: AppProps; apiUrl: string; config: ServerConfig; devSignIn: DevSignIn | null; hiddenDisconnectMs: number }) {
  const session = useMemo(() => {
    const auth: Auth = createAuth({ config, storage: props.storage, loadDescope: props.loadDescope, devSignIn });
    const api = createWebApi({
      baseUrl: apiUrl,
      getToken: () => auth.getToken(),
      refresh: () => auth.refresh(),
      signOut: (reason) => auth.signOut(reason),
      notify,
      reload: markClientOutdated,
      fetch: props.fetch === undefined ? guardedFetch : blockWhenOutdated(props.fetch),
    });
    return { auth, api: api satisfies ApiLike, collabUrl: config.collabUrl, apiUrl, hiddenDisconnectMs };
  }, [apiUrl, config, devSignIn, props, hiddenDisconnectMs]);
  const queryClient = useMemo(() => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } }), []);
  const router = useMemo(() => props.router(), [props]);
  return (
    <SessionContext.Provider value={session}>
      <QueryClientProvider client={queryClient}>
        <RequireSignIn auth={session.auth} here={props.here} redirect={props.redirect}>
          <RouterProvider router={router} />
        </RequireSignIn>
        <Toaster />
      </QueryClientProvider>
    </SessionContext.Provider>
  );
}
