import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { createAppRouter } from './app/router';
import { loadWebConfig } from './config';
import { createClientStorage } from './storage';
import { trackInputModality } from './ui/input-modality';
import './gate/gate.css';
import './ui/global.css';

// The entry of the app. The development sign-in and the identity provider's SDK are separate chunks: the first exists in development and test builds only,
// the second is requested only when a session exists and a token must be read or refreshed.
trackInputModality();
const storage = createClientStorage();
const devBuild = typeof __GRIMOIRE_DEV_SIGNIN__ !== 'undefined' && __GRIMOIRE_DEV_SIGNIN__;
const loadDevSignIn = devBuild ? async (apiUrl: string, s: typeof storage) => (await import('./auth/dev-signin')).createDevSignIn({ apiUrl, storage: s }) : null;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App
      loadConfig={() => loadWebConfig()}
      storage={storage}
      loadDescope={async () => (await import('./auth/descope-sdk')).default}
      loadDevSignIn={loadDevSignIn}
      router={createAppRouter}
      here={() => `${window.location.pathname}${window.location.search}`}
      redirect={(url) => window.location.replace(url)}
    />
  </StrictMode>,
);
