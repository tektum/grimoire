import { createServer } from 'node:net';
import { Server } from '@hocuspocus/server';
import { afterEach, describe, expect, it } from 'vitest';
import { connect, ConnectionRefused } from '../src/client.ts';
import type { Client } from '../src/client.ts';
import { eventually } from '../src/index.ts';

// The shared `connect` against a started (in-process) collaboration server: authenticated provider, clean close, named error on refusal.
const clients: Client[] = [];
const servers: Server[] = [];
async function start(): Promise<string> {
  const server = new Server({
    port: 0,
    quiet: true,
    onAuthenticate: ({ token }) => {
      if (token !== 'good') throw new Error('invalid-token');
      return Promise.resolve({ user: 'alice' });
    },
  });
  await server.listen();
  servers.push(server);
  return `ws://127.0.0.1:${String(server.address.port)}`;
}
const track = (c: Client): Client => { clients.push(c); return c; };

afterEach(async () => {
  clients.splice(0).forEach((c) => { c.destroy(); });
  await Promise.all(servers.splice(0).map((s) => s.destroy()));
});

describe('connect', () => {
  it('returns a provider that authenticates, and closes cleanly on destroy', async () => {
    const url = await start();
    let authenticated = 0;
    const c = track(connect(url, 'doc-1', 'good', { maxAttempts: 1, onAuthentication: () => { authenticated++; } }));
    await eventually(() => (authenticated > 0 || c.failures.length > 0 ? true : undefined), 3000, 'authenticated').catch((e: unknown) => { throw new Error(String(e) + JSON.stringify([c.failures, c.closes, c.provider.authorizedScope])); });
    expect(c.failures).toEqual([]);
    expect(c.provider.authorizedScope).toBe('read-write');
    c.destroy();
    await eventually(() => (servers[0]?.hocuspocus.getConnectionsCount() === 0 ? true : undefined), 3000, 'server saw the close');
  });

  it('reports the reason when the server refuses the token', async () => {
    const url = await start();
    const c = track(connect(url, 'doc-1', 'bad', { maxAttempts: 1 }));
    await eventually(() => (c.failures.length > 0 ? true : undefined), 5000, 'refused');
    expect(c.failures).toEqual(['permission-denied']);
  });

  it('fails with the named ConnectionRefused error when nothing accepts the connection', async () => {
    const free = await new Promise<number>((resolve) => {
      const s = createServer();
      s.listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => { resolve(port); }); });
    });
    let refused: ConnectionRefused | undefined;
    track(connect(`ws://127.0.0.1:${String(free)}`, 'doc-1', 'good', { maxAttempts: 1, refusal: (e) => { refused = e; } }));
    await eventually(() => refused, 10_000, 'refusal');
    expect(refused).toBeInstanceOf(ConnectionRefused);
    expect(refused?.name).toBe('ConnectionRefused');
    expect(refused?.message).toBe('collaboration connection refused');
  });
});
