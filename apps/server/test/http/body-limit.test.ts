import { createServer, request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { bodyLimit } from '../../src/http/body-limit.js';

const LIMIT = 10;
let server: Server | undefined;
afterEach(() => { server?.close(); server = undefined; });

/** The app behind the real node server, the way production runs it (the request object handed to middleware is not a real Request). */
function build(): Hono {
  const app = new Hono();
  app.use(bodyLimit({ maxSize: LIMIT }));
  app.all('/echo', async (c) => c.json({ method: c.req.method, body: await c.req.text() }));
  return app;
}
async function listen(app: Hono): Promise<number> {
  server = createServer(getRequestListener(app.fetch, { overrideGlobalObjects: false }));
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server?.address();
  return typeof address === 'object' && address !== null ? address.port : 0;
}
/** One request with the given chunks and no content-length (chunked transfer). */
function chunked(port: number, method: string, chunks: readonly string[]): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ port, host: '127.0.0.1', path: '/echo', method, headers: { 'transfer-encoding': 'chunked' } }, (res) => {
      let text = '';
      res.on('data', (d: Buffer) => { text += d.toString(); });
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, text }); });
    });
    req.on('error', reject);
    for (const c of chunks) req.write(c);
    req.end();
  });
}

describe('bodyLimit under node-server', () => {
  it('a chunked body over the limit is 413 too_large', async () => {
    const port = await listen(build());
    const r = await chunked(port, 'POST', ['12345', '67890', 'x']);
    expect([r.status, (JSON.parse(r.text) as { error: { code: string } }).error.code]).toEqual([413, 'too_large']);
  });
  it('a body under the limit reaches the handler intact', async () => {
    const port = await listen(build());
    const r = await chunked(port, 'POST', ['1234', '5678']);
    expect([r.status, JSON.parse(r.text)]).toEqual([200, { method: 'POST', body: '12345678' }]);
  });
  it('a DELETE with an empty chunked body reaches the handler', async () => {
    const port = await listen(build());
    const r = await chunked(port, 'DELETE', []);
    expect([r.status, JSON.parse(r.text)]).toEqual([200, { method: 'DELETE', body: '' }]);
  });
  it('a content-length over the limit is 413 without the body being read', async () => {
    const app = new Hono();
    let reads = 0;
    app.use(bodyLimit({ maxSize: LIMIT }));
    app.post('/echo', (c) => { reads += 1; return c.text('reached'); });
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { reads += 1000; controller.enqueue(new Uint8Array(4)); } }, { highWaterMark: 0 });
    const res = await app.fetch(new Request('http://x/echo', { method: 'POST', headers: { 'content-length': '11' }, body: stream, duplex: 'half' } as RequestInit));
    expect([res.status, reads]).toEqual([413, 0]);
  });
  it('a body within its declared length passes on untouched, without being buffered by the middleware', async () => {
    const app = build();
    const res = await app.fetch(new Request('http://x/echo', { method: 'POST', headers: { 'content-length': '5' }, body: 'hello' }));
    expect([res.status, await res.json()]).toEqual([200, { method: 'POST', body: 'hello' }]);
  });
});
