import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { beforeAll, expect, it } from 'vitest';
import { defaultWorkerPath } from '../../src/index.js';
import { ensureBuilt } from './support.js';

beforeAll(ensureBuilt);

it('resolves the worker next to the built module, and to dist from the sources', () => {
  expect(defaultWorkerPath('file:///app/packages/x/dist/pool.js')).toBe('/app/packages/x/dist/worker.js');
  expect(defaultWorkerPath('file:///app/packages/x/src/pool.ts')).toBe('/app/packages/x/dist/worker.js');
});

it('the built adapter works in a plain node process and the process ends by itself once the pool is closed', async () => {
  const script = fileURLToPath(new URL('./built-check.mjs', import.meta.url));
  // A thread left alive would keep the child running until this limit.
  const { stdout } = await promisify(execFile)(process.execPath, [script], { timeout: 30_000 });
  expect(stdout.trim()).toBe('OK');
}, 40_000);
