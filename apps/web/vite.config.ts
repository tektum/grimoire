import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Static files only: `base: './'` keeps every asset path relative, so any static host can serve the output (R11.23).
// Build modes: `production` (the default), `e2e` and `development`. The development sign-in exists in the last two only (contracts section 4).
export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [react(), tailwindcss()],
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
