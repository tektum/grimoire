import { type ReactNode, useEffect, useState } from 'react';
import { ErrorBoundary } from '../../app/ErrorBoundary';
import type { WebConfig } from '../../config';
import { Gate } from '../../gate/Gate';
import type { DevSignInOptions } from '../../auth/dev-signin';
import { LOGIN_TEXTS, LoginScreen, type LoginScreenProps } from './LoginScreen';

export interface LoginAppProps {
  /** Reads `./config.json`. */
  readonly loadConfig: () => Promise<WebConfig>;
  readonly search: string;
  readonly devBuild: boolean;
  readonly storage: DevSignInOptions['storage'];
  readonly go: LoginScreenProps['go'];
  readonly loadDevForm: LoginScreenProps['loadDevForm'];
  readonly loadDescopeFlow: LoginScreenProps['loadDescopeFlow'];
}

/**
 * The whole sign-in document: the settings of the page, the configuration gate, the screen. A failure at any step shows a plain message and never a blank
 * page: unreadable settings say so, and an error while rendering (a chunk that fails to load, for one) is caught by the same boundary as in the app.
 */
export function LoginApp(props: LoginAppProps): ReactNode {
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
          <p>{LOGIN_TEXTS.configFailed}</p>
        </main>
      ) : (
        <Gate options={{ apiUrl: web.apiUrl }}>
          {(config) => (
            <LoginScreen
              config={config}
              apiUrl={web.apiUrl}
              search={props.search}
              devBuild={props.devBuild}
              storage={props.storage}
              go={props.go}
              loadDevForm={props.loadDevForm}
              loadDescopeFlow={props.loadDescopeFlow}
            />
          )}
        </Gate>
      )}
    </ErrorBoundary>
  );
}
