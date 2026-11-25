import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { makeFakeConfig } from '@tektum/grimoire-core/testing/fake-config';
import type { Config } from '@tektum/grimoire-core/ports/config';
import { createRemoteImageFetcher } from '../../../src/import/remote-images/index.js';
import type { RemoteImageFetcher, RemoteImageTestSeams } from '../../../src/import/remote-images/index.js';

/** A 1x1 transparent PNG. */
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

export interface Seen { readonly url: string; readonly headers: IncomingMessage['headers'] }
export interface TestServer {
  readonly port: number;
  /** Every request the server received, in order. */
  readonly seen: Seen[];
  readonly ca: string;
  close(): Promise<void>;
}

/** A certificate for 127.0.0.1 and localhost, made by `openssl` into a scratch folder of the workspace (not /tmp) and removed with the server; nothing is committed. */
function certificate(dir: string): { key: string; cert: string } {
  mkdirSync(dir, { recursive: true });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,DNS:images.example,IP:127.0.0.1', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem')], { stdio: 'ignore' });
  return { key: readFileSync(join(dir, 'k.pem'), 'utf8'), cert: readFileSync(join(dir, 'c.pem'), 'utf8') };
}

let counter = 0;
export async function startServer(handler: (req: IncomingMessage, res: ServerResponse, server: { port: number }) => void): Promise<TestServer> {
  const dir = join(process.cwd(), 'test-results', `remote-images-tls-${String(process.pid)}-${String(counter++)}`);
  const { key, cert } = certificate(dir);
  const seen: Seen[] = [];
  const holder = { port: 0 };
  const server = createServer({ key, cert }, (req, res) => { seen.push({ url: req.url ?? '', headers: req.headers }); handler(req, res, holder); });
  const sockets = new Set<import('node:net').Socket>();
  server.on('connection', (s) => { sockets.add(s); s.once('close', () => sockets.delete(s)); });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  holder.port = (server.address() as AddressInfo).port;
  return {
    port: holder.port, seen, ca: cert,
    close: () => new Promise<void>((resolve) => { for (const s of sockets) s.destroy(); server.close(() => { rmSync(dir, { recursive: true, force: true }); resolve(); }); }),
  };
}

export const png = (res: ServerResponse): void => { res.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG.length }); res.end(PNG); };

/** A fetcher aimed at a test server: its port is allowed, its certificate trusted, and (when asked) the loopback address allowed. Nothing here is a setting. */
export function fetcherFor(server: TestServer, over: { config?: Partial<Config['import']>; allowLoopback?: boolean; lookup?: RemoteImageTestSeams['lookup']; now?: () => number } = {}): RemoteImageFetcher {
  const config = makeFakeConfig({ import: { remote: { maxImages: 200, maxBytes: 1_000_000, timeoutSeconds: 10, totalSeconds: 300 }, ...over.config } });
  const f = createRemoteImageFetcher(config, {
    ports: [server.port], ca: server.ca, ...(over.allowLoopback === true ? { allowAddresses: ['127.0.0.1'] } : {}), ...(over.lookup === undefined ? {} : { lookup: over.lookup }), ...(over.now === undefined ? {} : { now: over.now }),
  });
  if (f === undefined) throw new Error('no fetcher');
  return f;
}

export async function drain(bytes: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of bytes) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}
