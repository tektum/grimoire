import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { requireBuild } from '../server/support/harness.js';

const child = fileURLToPath(new URL('./fixtures/pool-shutdown-child.mjs', import.meta.url));
const run = (mode: 'hook' | 'bare') => spawnSync(process.execPath, [child, mode], { encoding: 'utf8', timeout: 30_000 });

beforeAll(() => { requireBuild(); });

describe('pool shutdown with a conversion in flight (correction 3)', () => {
  it('through the markdown-pool hook: the shutdown completes, the hook is done, the in-flight call gets a typed answer, exit code 0', () => {
    const r = run('hook');
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim()) as { code: number; result: { ok: boolean }; hooks: string[] };
    expect(out.code).toBe(0);
    expect(out.hooks).toEqual(['shutdown.hook_done']);
    expect(out.result.ok).toBe(false);
  });

  it('control: close() alone, with nothing else holding the event loop, ends the process with code 13 (an unsettled await): why the hook runner must hold it', () => {
    expect(run('bare').status).toBe(13);
  });
});
