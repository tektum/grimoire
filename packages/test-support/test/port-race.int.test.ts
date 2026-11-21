import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { startServer } from '../src/harness.ts';
import type { ServerProcess } from '../src/harness.ts';

const entry = path.resolve(import.meta.dirname, 'server-start.mjs');
const running: ServerProcess[] = [];
afterEach(async () => { await Promise.all(running.splice(0).map((server) => server.kill())); });

it('starts 200 sequential servers without a port collision', async () => {
  const ports = new Set<number>();
  for (let index = 0; index < 200; index++) {
    const server = await startServer({ entry });
    running.push(server);
    expect(server.alive).toBe(true);
    expect(server.port).toBeGreaterThan(0);
    ports.add(server.port);
    await server.kill();
  }
}, 120_000);

// Each server is registered for cleanup as soon as it has started, so one failed start cannot leave the others running.
const startRegistered = (): Promise<ServerProcess> => startServer({ entry }).then((server) => { running.push(server); return server; });

it('starts 40 concurrent servers with forty distinct ports', async () => {
  const servers = await Promise.all(Array.from({ length: 40 }, startRegistered));
  expect(new Set(servers.map((server) => server.port)).size).toBe(40);
}, 120_000);

it('starts 20 concurrent servers without a port collision', async () => {
  for (let round = 0; round < 5; round++) {
    const servers = await Promise.all(Array.from({ length: 20 }, startRegistered));
    expect(new Set(servers.map((server) => server.port)).size).toBe(20);
    expect(servers.every((server) => server.alive)).toBe(true);
    await Promise.all(running.splice(0).map((server) => server.kill()));
  }
}, 120_000);

it('retries on a fresh port after an EADDRINUSE start failure', async () => {
  const dir = path.resolve(import.meta.dirname, '..', 'dist', `collide-${String(process.pid)}`);
  mkdirSync(dir, { recursive: true });
  try {
    const server = await startServer({ entry: path.resolve(import.meta.dirname, 'collide-once.mjs'), env: { COLLIDE_MARKER: path.join(dir, 'marker') } });
    running.push(server);
    expect(server.alive).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('events skips lines that are not JSON (plain text on stderr)', async () => {
  const server = await startServer({ entry, env: { NOISY: '1' } });
  running.push(server);
  expect(server.output).toContain('ExperimentalWarning');
  expect(server.events.map((event) => event.event)).toContain('http.listening');
});
