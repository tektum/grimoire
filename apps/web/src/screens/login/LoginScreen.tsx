import { type ComponentType, lazy, Suspense, useMemo } from 'react';
import { safeReturn } from '../../app/routes';
import { SIGN_OUT_NOTICES } from '../../auth';
import type { DevSignInOptions } from '../../auth/dev-signin';
import type { ServerConfig } from '../../gate/config';
import './login.css';

export const LOGIN_TEXTS = {
  localInProduction: 'This server is in local development mode; sign-in is unavailable in this build',
  noProject: 'Sign-in is not set up on this server: no sign-in project is configured.',
  failed: 'Sign-in did not finish. Try again.',
} as const;

type DevFormProps = { options: DevSignInOptions; onSignedIn: () => void };
type DescopeProps = { projectId: string; baseUrl?: string; flowId?: string; onSuccess: () => void; onError: () => void };

export interface LoginScreenProps {
  readonly config: ServerConfig;
  readonly apiUrl: string;
  /** The query string of the page (`?return=...&reason=...&flow=descope`). */
  readonly search: string;
  /** Whether this build has the development sign-in (`__GRIMOIRE_DEV_SIGNIN__`). */
  readonly devBuild: boolean;
  /** Goes to a path of the app: the page after a sign-in. */
  readonly go: (path: string) => void;
  readonly storage: DevSignInOptions['storage'];
  /** The two sign-in chunks, loaded on demand: only the one the screen needs is requested. */
  readonly loadDevForm: () => Promise<{ default: ComponentType<DevFormProps> }>;
  readonly loadDescopeFlow: () => Promise<{ default: ComponentType<DescopeProps> }>;
}

/** `reason` of the query string, when it names one of the session endings that have a notice. */
function noticeFor(search: string): string | null {
  const reason = new URLSearchParams(search).get('reason');
  return reason === 'expired' || reason === 'suspended' || reason === 'not-allowed' ? SIGN_OUT_NOTICES[reason] : null;
}

export function LoginScreen(props: LoginScreenProps) {
  const params = new URLSearchParams(props.search);
  const target = safeReturn(params.get('return'));
  const notice = noticeFor(props.search);
  // `?flow=descope` forces the provider's flow in development and test builds (a test stubs a configuration that is not local); never in production.
  const forceDescope = props.devBuild && params.get('flow') === 'descope';
  const DevForm = useMemo(() => lazy(props.loadDevForm), [props.loadDevForm]);
  const Descope = useMemo(() => lazy(props.loadDescopeFlow), [props.loadDescopeFlow]);
  let body;
  if (props.config.local && !forceDescope) {
    body = props.devBuild ? (
      <Suspense fallback={null}>
        <DevForm options={{ apiUrl: props.apiUrl, storage: props.storage }} onSignedIn={() => props.go(target)} />
      </Suspense>
    ) : (
      <p className="login-notice">{LOGIN_TEXTS.localInProduction}</p>
    );
  } else if (props.config.providerProjectId === null) {
    body = <p className="login-notice">{LOGIN_TEXTS.noProject}</p>;
  } else {
    body = (
      <Suspense fallback={null}>
        <Descope
          projectId={props.config.providerProjectId}
          {...(props.config.providerBaseUrl == null ? {} : { baseUrl: props.config.providerBaseUrl })}
          onSuccess={() => props.go(target)}
          onError={() => undefined}
        />
      </Suspense>
    );
  }
  return (
    <main className="login">
      <h1>Sign in to Grimoire</h1>
      {notice !== null && (
        <p className="login-notice" role="status">
          {notice}
        </p>
      )}
      {body}
    </main>
  );
}
