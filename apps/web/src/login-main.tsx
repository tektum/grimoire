import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Gate } from './gate/Gate';
import { loadWebConfig } from './config';
import { LoginScreen } from './screens/login/LoginScreen';
import { createClientStorage } from './storage';
import './ui/global.css';

// The entry of the sign-in document. The development form and the provider's flow are separate chunks, requested only when the screen needs them.
const storage = createClientStorage();
const devBuild = typeof __GRIMOIRE_DEV_SIGNIN__ !== 'undefined' && __GRIMOIRE_DEV_SIGNIN__;
const loadDevForm = devBuild ? () => import('./auth/DevSignInForm') : () => Promise.reject(new Error('no development sign-in in this build'));

void loadWebConfig().then(({ apiUrl }) => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Gate options={{ apiUrl }}>
        {(config) => (
          <LoginScreen
            config={config}
            apiUrl={apiUrl}
            search={window.location.search}
            devBuild={devBuild}
            storage={storage}
            go={(path) => window.location.assign(path)}
            loadDevForm={loadDevForm}
            loadDescopeFlow={() => import('./auth/descope-signin')}
          />
        )}
      </Gate>
    </StrictMode>,
  );
});
