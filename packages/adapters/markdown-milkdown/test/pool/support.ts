import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PACKAGE_DIR = fileURLToPath(new URL('../../', import.meta.url));
export const FIXTURE_WORKER = fileURLToPath(new URL('./fixtures/behaviours.mjs', import.meta.url));

/**
 * The pooled converter runs the built `dist/worker.js` (a worker cannot start from the sources, see `defaultWorkerPath`),
 * so a test run first brings the build up to date; a no-op when it already is.
 */
export function ensureBuilt(): void {
  const tsc = fileURLToPath(new URL('../../../../../node_modules/typescript/bin/tsc', import.meta.url));
  execFileSync(process.execPath, [tsc, '-b', PACKAGE_DIR], { stdio: 'pipe' });
}
