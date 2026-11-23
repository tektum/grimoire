import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { freePort } from '../src/harness.ts';

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const gone = (pid: number): Promise<void> => vi.waitFor(() => { if (alive(pid)) throw new Error(`process ${String(pid)} is still running`); }, { timeout: 5000, interval: 50 });
const started: { parent: ReturnType<typeof spawn>; childPid: number }[] = [];
const direct: ReturnType<typeof spawn>[] = []; // children started by a test itself, killed even when the test timed out and its own finally never ran
// Whatever a failed assertion leaves behind is killed here: the stand-in runner and its server child.
afterEach(() => {
  for (const child of direct.splice(0)) child.kill('SIGKILL');
  for (const { parent, childPid } of started.splice(0)) {
    parent.kill('SIGKILL');
    try { process.kill(childPid, 'SIGKILL'); } catch { /* already gone */ }
  }
});
async function startParent(mode = 'idle'): Promise<{ parent: ReturnType<typeof spawn>; childPid: number }> {
  const port = await freePort(); // asked of the kernel: a random number in a range the system also hands out for outgoing connections was once already in use (EADDRINUSE)
  return new Promise((resolve, reject) => {
    const parent = spawn(process.execPath, [new URL('./orphan-parent.mjs', import.meta.url).pathname, String(port), mode], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    parent.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      const m = /child (\d+)/.exec(out);
      if (m?.[1] !== undefined) { const found = { parent, childPid: Number(m[1]) }; started.push(found); resolve(found); }
    });
    parent.once('exit', () => { if (mode === 'idle') reject(new Error(`the stand-in runner exited early: ${out}`)); });
  });
}

describe('a server child started through the helper does not outlive its parent', () => {
  it('SIGKILL of the parent (no handler can run): the child is gone within 5 s', async () => {
    const { parent, childPid } = await startParent();
    expect(alive(childPid)).toBe(true);
    parent.kill('SIGKILL');
    await gone(childPid);
  }, 20_000);

  it('the parent dies before the child has started (the child never sees its parent alive): the child is gone within 5 s', async () => {
    const { childPid } = await startParent('die-at-once');
    await gone(childPid);
  }, 20_000);

  it('SIGTERM of the parent (the default action ends it without exit handlers): the child is gone within 5 s', async () => {
    const { parent, childPid } = await startParent();
    parent.kill('SIGTERM');
    await gone(childPid);
  }, 20_000);

  it('the preload decides at load time, with no timing involved: a child whose named parent is not its parent ends before it runs', async () => {
    const watch = new URL('../src/parent-watch.mjs', import.meta.url).pathname;
    const server = new URL('./server-start.mjs', import.meta.url).pathname;
    // A pid that is not this process's: from the child's point of view the parent it was started for is already gone.
    // The poll is stretched to ten minutes, so only the check at load can end this child within the test: deleting that check makes the test fail.
    const child = spawn(process.execPath, ['--import', watch, server], { env: { ...process.env, GRIMOIRE_PORT: '0', GRIMOIRE_TEST_PARENT_PID: String(process.pid + 1_000_000), GRIMOIRE_TEST_PARENT_POLL_MS: '600000' }, stdio: 'ignore' });
    direct.push(child);
    try {
      const ended = new Promise<string | null>((resolve) => { child.once('exit', (_code, signal) => { resolve(signal); }); });
      expect(await ended).toBe('SIGKILL');
    } finally { child.kill('SIGKILL'); } // and the afterEach does it again if the test timed out before this line
  }, 20_000);

  it('a child whose named parent is its parent starts and serves: the load-time check does not end it', async () => {
    const watch = new URL('../src/parent-watch.mjs', import.meta.url).pathname;
    const server = new URL('./server-start.mjs', import.meta.url).pathname;
    const child = spawn(process.execPath, ['--import', watch, server], { env: { ...process.env, GRIMOIRE_PORT: '0', GRIMOIRE_TEST_PARENT_PID: String(process.pid) }, stdio: ['ignore', 'pipe', 'ignore'] });
    direct.push(child);
    try {
      let out = '';
      child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
      await vi.waitFor(() => { expect(out).toContain('http.listening'); }, { timeout: 10_000, interval: 50 });
      expect(child.signalCode).toBeNull();
    } finally { child.kill('SIGKILL'); }
  }, 20_000);
});
