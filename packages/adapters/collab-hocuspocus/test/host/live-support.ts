import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { connect as connectClient, eventually } from '@tektum/grimoire-test-support';
import type { Client, ConnectOptions } from '@tektum/grimoire-test-support';
import type { CollabHostOptions, HocuspocusCollabHost } from '../../src/host.js';
import { createCollabHost } from '../../src/host.js';
import { makeDeps } from './support.js';

export { eventually };

export interface Live {
  readonly host: HocuspocusCollabHost;
  readonly server: Server;
  readonly url: string;
  readonly t: ReturnType<typeof makeDeps>;
  stop(): Promise<void>;
}

/** A real HTTP server with the host attached on /collab, over fake deps. */
export async function startLive(role: 'admin' | 'member' | 'viewer' | undefined, options: CollabHostOptions = {}, configure?: (t: ReturnType<typeof makeDeps>) => void): Promise<Live> {
  const t = makeDeps(role);
  configure?.(t);
  const host = createCollabHost(options);
  await host.start(t.deps);
  const server = createServer();
  server.on('upgrade', (req, socket, head) => { host.handleUpgrade(req, socket, head); });
  await new Promise<void>((r) => { server.listen(0, '127.0.0.1', r); });
  const port = (server.address() as AddressInfo).port;
  return {
    host, server, t, url: `ws://127.0.0.1:${String(port)}/collab`,
    async stop() { await host.shutdown({ deadlineMs: 500 }); server.closeAllConnections(); await new Promise<void>((r) => { server.close(() => { r(); }); }); },
  };
}

export { ALLOWED_ORIGIN } from '@tektum/grimoire-test-support';
export type { Client };
export const connect = (live: Live, name: string, token: string | (() => string) = 't', options: ConnectOptions = {}): Client => connectClient(live, name, token, options);
