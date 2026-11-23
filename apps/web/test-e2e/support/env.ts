import { readFileSync } from 'node:fs';
import path from 'node:path';
import { readDevSecret } from '../../test/support/dev-token';

/** The repository root, from this file's place (`apps/web/test-e2e/support`). */
export const repoRoot = path.resolve(import.meta.dirname, '../../../..');

/** The API the tests talk to: `E2E_API_URL`, else the Compose stack's published address. */
export const apiUrl = (): string => (process.env['E2E_API_URL'] ?? 'http://127.0.0.1:8080').replace(/\/+$/, '');

/** The development token secret: `E2E_DEV_TOKEN_SECRET`, else the one in `.env`. Throws a one-line DevTokenError when there is none. */
export function devSecret(): string {
  let file: string | undefined;
  try {
    file = readFileSync(path.join(repoRoot, '.env'), 'utf8');
  } catch {
    file = undefined;
  }
  return readDevSecret(process.env, file);
}
