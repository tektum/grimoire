import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRemoteBudget } from '../../../src/import/remote-images/index.js';
import { drain, fetcherFor, PNG, png, startServer } from './support.js';
import type { TestServer } from './support.js';

// M7-T09: per-image and per-import limits, and what a response must be to be an image.
let written = 0;
let server: TestServer;
beforeAll(async () => {
  server = await startServer((req, res) => {
    switch (req.url) {
      case '/ok': png(res); break;
      case '/big': {
        res.writeHead(200, { 'content-type': 'image/png' });
        const chunk = Buffer.alloc(100, 0);
        const pump = (): void => { while (written < 5_000_000) { written += chunk.length; if (!res.write(chunk)) { res.once('drain', pump); return; } } res.end(); };
        res.on('error', () => undefined);
        PNG.copy(chunk); pump();
        break;
      }
      case '/slow': break; // never answers
      case '/svg': res.writeHead(200, { 'content-type': 'image/svg+xml' }); res.end('<svg xmlns="http://www.w3.org/2000/svg"/>'); break;
      case '/html': res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html></html>'); break;
      case '/disguised': res.writeHead(200, { 'content-type': 'image/png' }); res.end('<html><body>not a png</body></html>'); break;
      case '/mismatch': res.writeHead(200, { 'content-type': 'image/jpeg' }); res.end(PNG); break;
      default: res.writeHead(404); res.end();
    }
  });
}, 60_000);
afterAll(async () => { await server.close(); });

const cfg = (over: Partial<{ maxImages: number; maxBytes: number; timeoutSeconds: number; totalSeconds: number }> = {}) => ({ remote: { maxImages: 200, maxBytes: 1000, timeoutSeconds: 10, totalSeconds: 300, ...over } });
const url = (path: string): string => `https://127.0.0.1:${String(server.port)}${path}`;
const fetcher = (over: Parameters<typeof cfg>[0] = {}, now?: () => number) => fetcherFor(server, { allowLoopback: true, config: cfg(over), ...(now === undefined ? {} : { now }) });

describe('size', () => {
  it('an image of the limit passes, and one byte more is too_large after at most the limit plus one chunk was read', async () => {
    const ok = await fetcher({ maxBytes: PNG.length }).fetch(url('/ok'), createRemoteBudget(cfg()));
    expect(ok).toMatchObject({ ok: true, size: PNG.length });
    written = 0;
    const big = await fetcher({ maxBytes: 1000 }).fetch(url('/big'), createRemoteBudget(cfg()));
    expect(big).toEqual({ ok: false, reason: 'too_large' });
    await new Promise((r) => setTimeout(r, 200)); // the server notices the closed socket
    expect(written).toBeLessThan(1_000_000);
  });

  it('an image one byte over the limit is too_large, by its declared length too', async () => {
    expect(await fetcher({ maxBytes: PNG.length - 1 }).fetch(url('/ok'), createRemoteBudget(cfg()))).toEqual({ ok: false, reason: 'too_large' });
  });
});

describe('time', () => {
  it('a server that never answers is a timeout within the per-image timeout plus a second', async () => {
    const t = Date.now();
    expect(await fetcher({ timeoutSeconds: 1 }).fetch(url('/slow'), createRemoteBudget(cfg()))).toEqual({ ok: false, reason: 'timeout' });
    expect(Date.now() - t).toBeLessThan(2000);
  });
});

describe('the budget of one import', () => {
  it('refuses the image after the last one the budget allows', async () => {
    const budget = createRemoteBudget(cfg({ maxImages: 2 }));
    const f = fetcher({ maxBytes: 100_000 });
    expect((await f.fetch(url('/ok'), budget)).ok).toBe(true);
    expect((await f.fetch(url('/ok'), budget)).ok).toBe(true);
    expect(await f.fetch(url('/ok'), budget)).toEqual({ ok: false, reason: 'budget' });
  });

  it('refuses an image after the total time budget', async () => {
    let now = 0;
    const budget = createRemoteBudget(cfg({ totalSeconds: 10 }), () => now);
    const f = fetcher({ maxBytes: 100_000 }, () => now);
    expect((await f.fetch(url('/ok'), budget)).ok).toBe(true);
    now = 10_001;
    expect(await f.fetch(url('/ok'), budget)).toEqual({ ok: false, reason: 'budget' });
  });
});

describe('what an image is', () => {
  it.each([['/svg', 'image/svg+xml'], ['/html', 'text/html'], ['/disguised', 'image/png with HTML bytes'], ['/mismatch', 'image/jpeg with PNG bytes']])('%s (%s) is refused as type', async (path) => {
    expect(await fetcher({ maxBytes: 100_000 }).fetch(url(path), createRemoteBudget(cfg()))).toEqual({ ok: false, reason: 'type' });
  });

  it('a 404 is a status', async () => {
    expect(await fetcher().fetch(url('/missing'), createRemoteBudget(cfg()))).toEqual({ ok: false, reason: 'status' });
  });

  it('the bytes that come back are the image', async () => {
    const r = await fetcher({ maxBytes: 100_000 }).fetch(url('/ok'), createRemoteBudget(cfg()));
    if (!r.ok) throw new Error(r.reason);
    expect((await drain(r.bytes)).equals(PNG)).toBe(true);
  });
});
