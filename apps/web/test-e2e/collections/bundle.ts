import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { build } from 'vite';

export interface Bundle {
  readonly js: string;
  readonly css: string;
}

/**
 * Bundles one harness file of this folder for a browser page: one script and one stylesheet, built in memory (`write: false`), so nothing is left on
 * disk. The harness draws a screen of the client with fake data, in a page of the test's own server: no API and no sign-in are involved.
 */
export async function bundleHarness(file: string): Promise<Bundle> {
  const built = await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [react(), tailwindcss()],
    define: { 'process.env.NODE_ENV': '"production"' },
    build: { write: false, minify: false, cssCodeSplit: false, lib: { entry: path.join(import.meta.dirname, file), formats: ['iife'], name: 'Harness', fileName: 'harness' } },
  });
  const outputs = (Array.isArray(built) ? built : [built]).flatMap((b) => ('output' in b ? b.output : []));
  const js = outputs.find((o) => o.type === 'chunk');
  const css = outputs.find((o) => o.type === 'asset' && o.fileName.endsWith('.css'));
  if (js?.type !== 'chunk') throw new Error('the harness was not bundled');
  return { js: js.code, css: css?.type === 'asset' ? String(css.source) : '' };
}
