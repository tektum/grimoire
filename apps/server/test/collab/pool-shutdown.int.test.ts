import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { requireBuild } from '../server/support/harness.js';

const child = fileURLToPath(new URL('./fixtures/pool-shutdown-child.mjs', import.meta.url));
const run = (mode: 'hook' | 'bare' | 'deadline') => spawnSync(process.execPath, [child, mode], { encoding: 'utf8', timeout: 30_000 });

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

  // History: this used to expect exit code 13. piscina's own close() never settled after it terminated a spinning worker, so a bare close()
  // left the process with an unsettled await and the hook runner (which holds the event loop) was what made shutdown finish. The pool now
  // waits for its calls itself and closes an idle pool, so a bare close() settles and the process exits 0. The hook test above still proves the
  // runner reports `shutdown.hook_done` inside its deadline; the control below now proves the property the pool owns.
  it('control: a bare close() settles, and the process exits 0', () => {
    const r = run('bare');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^closed \d+\n$/);
  });

  it('control: a call that outlasts its own limit is cut off at the close deadline (300 ms), not left to run for its 15 s spin; without the deadline this fails', () => {
    const r = run('deadline');
    expect(r.status).toBe(0);
    const ms = Number(/^closed (\d+)\n$/.exec(r.stdout)?.[1]);
    expect(ms).toBeLessThan(5_000);
  });
});
