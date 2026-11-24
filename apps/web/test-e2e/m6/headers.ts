import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { apiUrl, repoRoot } from '../support/env.ts';

/** What `GET /v1/config` says that the headers need: where the collaboration server and the file store are. */
export interface StackConfig {
  readonly collabUrl: string;
  readonly fileStoreOrigin: string | null;
}

/** The store of the development stack, which the application signs links for (`make test-m6` sets GRIMOIRE_S3_PUBLIC_ENDPOINT to it). */
export const DEV_STORE_ORIGIN = 'http://127.0.0.1:8333';

/** The arguments of `render-headers.mjs` for this stack: the origins the client talks to, as the stack says them, so that the content security policy allows exactly those. */
export function headerArgs(api: string, config: StackConfig, out: string): string[] {
  return ['scripts/render-headers.mjs', '--api-origin', new URL(api).origin, '--collab-origin', new URL(config.collabUrl).origin, '--store-origin', config.fileStoreOrigin ?? DEV_STORE_ORIGIN, '--out', out];
}

// `bun run headers.ts`: renders the headers of the client for the running stack into test-results/m6-headers and prints the folder (`make test-m6` serves the client with it).
if (import.meta.main) {
  const api = apiUrl();
  const config = (await (await fetch(`${api}/v1/config`)).json()) as StackConfig;
  const out = path.join(repoRoot, 'test-results/m6-headers');
  mkdirSync(out, { recursive: true });
  const run = spawnSync('node', headerArgs(api, config, out), { cwd: path.join(repoRoot, 'apps/web'), encoding: 'utf8' });
  if (run.status !== 0) {
    process.stderr.write(`${run.stderr || run.stdout}`);
    process.exit(1);
  }
  process.stdout.write(`${out}\n`);
}
