import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRemoteBudget } from '../../../src/import/remote-images/index.js';
import { drain, fetcherFor, PNG, png, startServer } from './support.js';
import type { TestServer } from './support.js';

// M7-T09: redirects are followed by a manual loop of at most 3 hops, each hop validated again (scheme, port, address) and sent through the same filter.
let server: TestServer;
beforeAll(async () => {
  server = await startServer((req, res, s) => {
    const base = `https://127.0.0.1:${String(s.port)}`;
    const to = (location: string): void => { res.writeHead(302, { location }); res.end(); };
    switch (req.url) {
      case '/img': png(res); break;
      case '/r1': to('/r2'); break;
      case '/r2': to(`${base}/r3`); break;
      case '/r3': to('/img'); break;
      case '/r4': to('/r1'); break;
      case '/loop': to('/loop'); break;
      case '/private': to(`https://10.0.0.1:${String(s.port)}/x`); break;
      case '/metadata': to(`https://169.254.169.254:${String(s.port)}/latest/`); break;
      case '/plain': to(`http://127.0.0.1:${String(s.port)}/img`); break;
      case '/no-location': res.writeHead(302); res.end(); break;
      default: res.writeHead(404); res.end();
    }
  });
}, 60_000);
afterAll(async () => { await server.close(); });

const run = (path: string) => {
  const cfg = { remote: { maxImages: 200, maxBytes: 1_000_000, timeoutSeconds: 10, totalSeconds: 300 } };
  return fetcherFor(server, { allowLoopback: true }).fetch(`https://127.0.0.1:${String(server.port)}${path}`, createRemoteBudget(cfg));
};

describe('redirects', () => {
  it('follows up to three, relative or absolute, to the image', async () => {
    const r = await run('/r1');
    if (!r.ok) throw new Error(r.reason);
    expect((await drain(r.bytes)).equals(PNG)).toBe(true);
  });

  it('refuses the fourth hop as redirect', async () => {
    expect(await run('/r4')).toEqual({ ok: false, reason: 'redirect' });
  });

  it('ends a loop with redirect', async () => {
    expect(await run('/loop')).toEqual({ ok: false, reason: 'redirect' });
  });

  it('refuses a redirect to a private or metadata address on the second hop, the first having been allowed', async () => {
    const before = server.seen.length;
    expect(await run('/private')).toEqual({ ok: false, reason: 'blocked_address' });
    expect(await run('/metadata')).toEqual({ ok: false, reason: 'blocked_address' });
    expect(server.seen.length - before).toBe(2); // the first hop of each, and nothing after
  });

  it('refuses a redirect to http:// as scheme', async () => {
    expect(await run('/plain')).toEqual({ ok: false, reason: 'scheme' });
  });

  it('a redirect with no Location is a status, not a hang', async () => {
    expect(await run('/no-location')).toEqual({ ok: false, reason: 'status' });
  });
});
