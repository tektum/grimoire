import { createServer as createNetServer } from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { Server } from '@hocuspocus/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

/** The probe behind R11.34: the `token` option is the one channel the provider re-evaluates on every connect and automatic reconnect. */
const wrapper = (n: number): string => `g1.${Buffer.from(JSON.stringify({ t: 'session', e: n })).toString('base64url')}`;
const epochOf = (w: string): number => (JSON.parse(Buffer.from(w.slice(3), 'base64url').toString()) as { e: number }).e;

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanup.splice(0).reverse()) await c(); });

describe('handshake transport', () => {
  it('the token function runs again on the provider\'s automatic reconnect, and its wrapper reaches onAuthenticate', async () => {
    const seen: string[] = [];
    const server = new Server({ quiet: true, stopOnSignals: false, onAuthenticate: ({ token }) => { seen.push(token); return Promise.resolve(); } });
    const tcp: Socket[] = [];
    server.httpServer.on('connection', (s: Socket) => { tcp.push(s); });
    const probe = createNetServer();
    await new Promise<void>((r) => { probe.listen(0, '127.0.0.1', r); });
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => { probe.close(() => { r(); }); });
    await server.listen(port);
    cleanup.push(() => server.destroy());

    let n = 0;
    const socket = new HocuspocusProviderWebsocket({ url: server.webSocketURL, delay: 20, minDelay: 20, maxDelay: 50 });
    const provider = new HocuspocusProvider({ websocketProvider: socket, document: new Y.Doc(), name: 'doc', token: () => Promise.resolve(wrapper(n++)) });
    provider.attach();
    cleanup.push(() => { provider.destroy(); socket.destroy(); });

    await vi.waitFor(() => { expect(seen).toHaveLength(1); }, { timeout: 10_000 });
    expect(seen[0]).toBe(wrapper(0));
    for (const s of tcp) s.destroy(); // the server ends the socket; nothing in this test calls connect() again
    await vi.waitFor(() => { expect(seen).toHaveLength(2); }, { timeout: 10_000 });
    expect(seen[1]).toBe(wrapper(1));
    expect(epochOf(seen[1] ?? '')).not.toBe(epochOf(seen[0] ?? ''));
  }, 30_000);
});
