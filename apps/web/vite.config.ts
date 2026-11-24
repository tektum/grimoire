import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin, type PreviewServer, type ViteDevServer } from 'vite';

// Static files only: `base: './'` keeps every asset path relative, so any static host can serve the output (R11.23).
// Build modes: `production` (the default), `e2e` and `development`. The development sign-in exists in the last two only (contracts section 4).
// `/login` is the sign-in document (login.html): the development server and the preview server map it, as `scripts/serve.mjs` and a host's redirects file do.
const loginDocument = (): Plugin => {
  // The hook returns nothing: a function returned from `configureServer` would run as a later hook.
  const rewrite = (server: ViteDevServer | PreviewServer): void => {
    server.middlewares.use((req, _res, next) => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname === '/login') req.url = `/login.html${url.search}`;
      next();
    });
  };
  return { name: 'grimoire-login-document', configureServer: rewrite, configurePreviewServer: rewrite };
};

export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [react(), tailwindcss(), loginDocument()],
  define: {
    __GRIMOIRE_DEV_SIGNIN__: JSON.stringify(mode === 'e2e' || mode === 'development'),
  },
  server: { port: 5173, strictPort: true },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: { input: { index: 'index.html', login: 'login.html' } },
  },
}));
