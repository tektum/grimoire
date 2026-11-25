import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRemoteBudget, REMOTE_IMAGE_USER_AGENT } from '../../../src/import/remote-images/index.js';
import { fetcherFor, png, startServer } from './support.js';
import type { TestServer } from './support.js';

// M7-T09: what the request carries, and the URLs that are refused before any request.
let server: TestServer;
beforeAll(async () => { server = await startServer((_req, res) => { png(res); }); }, 60_000);
afterAll(async () => { await server.close(); });
const budget = () => createRemoteBudget({ remote: { maxImages: 200, maxBytes: 1_000_000, timeoutSeconds: 10, totalSeconds: 300 } });

describe('the request', () => {
  it('carries no cookie, authorisation or referer, and a fixed user agent', async () => {
    const r = await fetcherFor(server, { allowLoopback: true }).fetch(`https://127.0.0.1:${String(server.port)}/a.png`, budget());
    expect(r.ok).toBe(true);
    const seen = server.seen.at(-1);
    expect(seen?.headers['cookie']).toBeUndefined();
    expect(seen?.headers['authorization']).toBeUndefined();
    expect(seen?.headers['referer']).toBeUndefined();
    expect(seen?.headers['user-agent']).toBe(REMOTE_IMAGE_USER_AGENT);
  });
});

describe('URLs refused before any request', () => {
  it.each([
    ['credentials', (p: number) => `https://u:p@127.0.0.1:${String(p)}/a.png`],
    ['a username only', (p: number) => `https://u@127.0.0.1:${String(p)}/a.png`],
    ['http', (p: number) => `http://127.0.0.1:${String(p)}/a.png`],
    ['ftp', () => 'ftp://example.com/a.png'],
    ['data', () => 'data:image/png;base64,AAAA'],
    ['file', () => 'file:///etc/passwd'],
    ['javascript', () => 'javascript:alert(1)'],
  ])('%s is a scheme refusal and sends nothing', async (_n, make) => {
    const before = server.seen.length;
    expect(await fetcherFor(server, { allowLoopback: true }).fetch(make(server.port), budget())).toEqual({ ok: false, reason: 'scheme' });
    expect(server.seen.length).toBe(before);
  });

  it('a port the fetcher does not allow is refused as scheme, and an address that is not a URL is too', async () => {
    const before = server.seen.length;
    expect(await fetcherFor(server, { allowLoopback: true }).fetch(`https://127.0.0.1:${String(server.port + 1)}/a.png`, budget())).toEqual({ ok: false, reason: 'scheme' });
    expect(await fetcherFor(server, { allowLoopback: true }).fetch('not a url', budget())).toEqual({ ok: false, reason: 'scheme' });
    expect(server.seen.length).toBe(before);
  });

  it('the production fetcher allows port 443 only', async () => {
    const { createRemoteImageFetcher } = await import('../../../src/import/remote-images/index.js');
    const { makeFakeConfig } = await import('@tektum/grimoire-core/testing/fake-config');
    const f = createRemoteImageFetcher(makeFakeConfig());
    expect(await f?.fetch('https://example.com:8443/a.png', budget())).toEqual({ ok: false, reason: 'scheme' });
  });
});

describe('the switch', () => {
  it('there is no fetcher when remote images are not to be fetched', async () => {
    const { createRemoteImageFetcher } = await import('../../../src/import/remote-images/index.js');
    const { makeFakeConfig } = await import('@tektum/grimoire-core/testing/fake-config');
    expect(createRemoteImageFetcher(makeFakeConfig({ import: { fetchRemoteImages: false } }))).toBeUndefined();
  });
});
