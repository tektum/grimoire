import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { loadWebConfig } from './config';
import { LoginApp } from './screens/login/LoginApp';
import { appTarget } from './screens/login/target';
import { createClientStorage } from './storage';
import './gate/gate.css';
import './ui/global.css';

// The entry of the sign-in document. The development form and the provider's flow are separate chunks, requested only when the screen needs them.
const devBuild = typeof __GRIMOIRE_DEV_SIGNIN__ !== 'undefined' && __GRIMOIRE_DEV_SIGNIN__;
const loadDevForm = devBuild ? () => import('./auth/DevSignInForm') : () => Promise.reject(new Error('no development sign-in in this build'));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LoginApp
      loadConfig={() => loadWebConfig()}
      search={window.location.search}
      devBuild={devBuild}
      storage={createClientStorage()}
      go={(path) => window.location.assign(appTarget(path, window.location.origin))}
      loadDevForm={loadDevForm}
      loadDescopeFlow={() => import('./auth/descope-signin')}
    />
  </StrictMode>,
);
