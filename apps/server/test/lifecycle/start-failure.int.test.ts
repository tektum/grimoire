import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appUrl, createTestDatabase, dropTestDatabase, freePort, mainJs, requireBuild } from '../server/support/harness.js';
import { listenerReport, TRACK_LISTENERS, withoutListenerReport } from '@tektum/grimoire-test-support/harness';
import type { ListenerReport } from '@tektum/grimoire-test-support/harness';

const DB = `grimoire_m3t01b_start_${String(process.pid)}`;
const children = new Set<ReturnType<typeof spawn>>();
beforeEach(async () => { requireBuild(); await createTestDatabase(DB, true); });
afterEach(async () => {
  for (const child of children) child.kill('SIGKILL');
  children.clear();
  await dropTestDatabase(DB);
});

const listen = (server: net.Server, port: number): Promise<void> => new Promise((resolve) => { server.listen(port, '127.0.0.1', resolve); });

const closed = (server: net.Server): Promise<void> => new Promise((resolve) => { server.close(() => { resolve(); }); });

interface ChildResult { readonly code: number | null; readonly output: string; readonly listeners: ListenerReport | undefined }
function runEntrypoint(args: readonly string[], env: Readonly<Record<string, string>>): Promise<ChildResult> {
  const { promise, resolve } = Promise.withResolvers<ChildResult>();
  const child = spawn(process.execPath, ['--import', TRACK_LISTENERS, ...args], {
    env: {
      PATH: process.env['PATH'] ?? '', GRIMOIRE_LOCAL: '1', GRIMOIRE_DEV_TOKEN_SECRET: 'test-secret-0123456789abcdef',
      GRIMOIRE_ALLOWED_ORIGINS: 'http://127.0.0.1:8080', GRIMOIRE_HOST: '127.0.0.1', ...env,
    }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let output = '';
  const data = (d: Buffer): void => { output += d.toString(); };
  child.stdout.on('data', data);
  child.stderr.on('data', data);
  child.on('close', (code) => { children.delete(child); resolve({ code, output: withoutListenerReport(output), listeners: listenerReport(output) }); });
  return promise;
}

describe('start-time failures (S15)', () => {
  it('a second-port listen failure closes the started collaboration host and leaves no listening socket', async () => {
    const blocker = net.createServer();
    const collabPort = await freePort();
    await listen(blocker, collabPort);
    try {
      // The premise is that the HTTP port is free and only the collaboration port is taken. The HTTP port comes from freePort, which another test file may
      // take first (the kernel reuses ports); then nothing was started and the premise failed, so the setup is repeated with a fresh port (as startServer does).
      let result: ChildResult | undefined;
      for (let attempt = 0; attempt < 5 && (result === undefined || result.listeners?.started === 0); attempt++) {
        const port = await freePort();
        result = await runEntrypoint([mainJs], { GRIMOIRE_PORT: String(port), GRIMOIRE_COLLAB_PORT: String(collabPort), GRIMOIRE_DATABASE_URL: appUrl(DB) });
      }
      if (result === undefined) throw new Error('no run');
      expect(result.code).toBe(1); // the documented start failure code
      expect(result.output.match(/"event":"server.start_failed"/g)).toHaveLength(1);
      expect(result.output).toContain('"errorCode":"EADDRINUSE"');
      // The listeners themselves: the HTTP listener did start, and every listener the process started is closed again at exit (no probe of a port number
      // that a parallel test file could have taken in the meantime).
      expect(result.listeners?.started).toBe(1);
      expect(result.listeners?.stillListening).toBe(0);
    } finally {
      await closed(blocker);
    }
  });

  it('a failure after the host has started runs the registered shutdown: the HTTP listener closes, exit 1, one fixed failure logged (the host\'s own shutdown on a failed attachment is covered in start-signal.test.ts)', async () => {
    const port = await freePort();
    const entry = fileURLToPath(new URL('./fixtures/start-collab-failure.mjs', import.meta.url));
    const collabPort = await freePort();
    const result = await runEntrypoint([entry], { GRIMOIRE_PORT: String(port), GRIMOIRE_COLLAB_PORT: String(collabPort), GRIMOIRE_DATABASE_URL: appUrl(DB) });
    expect(result.code).toBe(1);
    expect(result.listeners?.started).toBeGreaterThanOrEqual(1); // the HTTP listener had started
    expect(result.listeners?.stillListening).toBe(0); // and is closed (the Hocuspocus host has no listener of its own)
    expect(result.output.match(/"event":"server.start_failed"/g)).toHaveLength(1);
    expect(result.output).toContain('"errorName":"TypeError"');
  });
  it('SIGTERM while collaboration startup is suspended exits cleanly and releases the port', async () => {
    const port = await freePort();
    const collabPort = String(await freePort());
    const entry = fileURLToPath(new URL('./fixtures/start-failure-fixture.mjs', import.meta.url));
    const result = await runEntrypoint([entry], { GRIMOIRE_PORT: String(port), GRIMOIRE_COLLAB_PORT: collabPort, GRIMOIRE_DATABASE_URL: appUrl(DB) });
    expect(result.code).toBe(0);
    expect(result.output).not.toContain('server.start_failed');
    expect(result.listeners?.stillListening).toBe(0); // every listener that had started, the collaboration host included, is closed
  }, 30_000);

  it('a failed CLI migration exits 1 and does not expose a listening socket', async () => {
    await createTestDatabase(DB, false); // empty database: the fixture's own migration is the one that runs and fails
    const result = await runEntrypoint([mainJs.replace(/main\.js$/, 'cli.js'), 'migrate', '--dir', fileURLToPath(new URL('./fixtures/bad-migration', import.meta.url))], { GRIMOIRE_DATABASE_MIGRATION_URL: `postgresql://grimoire_migrator:grimoire-dev@127.0.0.1:55432/${DB}` });
    expect(result.code).toBe(1);
    expect(result.output).toContain('"event":"migrate.failed"');
    expect(result.output).toContain('0001_broken'); // the message names the migration that failed
    expect(result.output).toContain('deliberate startup migration failure'); // and its own up() ran
    expect(result.output).not.toContain('grimoire-dev');
  });
});

describe('the command line (usage errors)', () => {
  it.each([['migrate', '--unknown'], ['migrate', '--dir']])('grimoire %s %s is a usage error: exit 2, no stack trace', async (command, option) => {
    const result = await runEntrypoint([mainJs.replace(/main\.js$/, 'cli.js'), command, option], { GRIMOIRE_DATABASE_MIGRATION_URL: appUrl(DB) });
    expect(result.code).toBe(2);
    expect(result.output).toContain('usage: grimoire migrate');
    expect(result.output).not.toContain('ERR_PARSE_ARGS');
  });
});
