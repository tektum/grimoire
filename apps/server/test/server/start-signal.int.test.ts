import { afterEach, describe, expect, it } from 'vitest';
import { appUrl, requireBuild, mainJs } from './support/harness.js';
import type { ServerProcess } from './support/harness.js';
import { spawn } from 'node:child_process';
import { freePort } from './support/harness.js';

// No database is reached before the signal, so a dummy URL is enough.
const DB_URL = appUrl('grimoire');
const running: ServerProcess[] = [];
afterEach(async () => { await Promise.all(running.splice(0).map((s) => s.kill())); });

/** Starts the real entry point and sends SIGTERM `delayMs` after its first log line: during start-up, before it listens or just after. */
function signalledStart(delayMs: number): Promise<{ code: number | null; output: string }> {
  return freePort().then((port) => new Promise((resolve) => {
    const child = spawn(process.execPath, [mainJs], {
      env: {
        PATH: process.env['PATH'] ?? '', GRIMOIRE_LOCAL: '1', GRIMOIRE_DEV_TOKEN_SECRET: 'test-secret-0123456789abcdef', GRIMOIRE_ALLOWED_ORIGINS: 'http://127.0.0.1:8080',
        GRIMOIRE_HOST: '127.0.0.1', GRIMOIRE_PORT: String(port), GRIMOIRE_DATABASE_URL: DB_URL,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = ''; let sent = false;
    const onData = (d: Buffer): void => {
      output += d.toString();
      if (!sent && output.includes('server.starting')) { sent = true; setTimeout(() => { child.kill('SIGTERM'); }, delayMs); }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('close', (code) => { resolve({ code, output }); });
  }));
}

describe('SIGTERM during start-up shuts down cleanly (S8)', () => {
  it.each([0, 3, 8, 15, 30, 60])('signal %i ms after server.starting: exit 0, no server.start_failed', async (delay) => {
    requireBuild();
    const r = await signalledStart(delay);
    expect(r.output).not.toContain('server.start_failed');
    expect(r.code).toBe(0);
  }, 30_000);
});
