import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRemoteBudget } from '../../../src/import/remote-images/index.js';
import { fetcherFor, png, startServer } from './support.js';
import type { TestServer } from './support.js';

// M7-T09 (contracts section 5): with the default filter, nothing that is not a public address is reached, by literal, by name, or by DNS; the server sees no request.
let server: TestServer;
beforeAll(async () => { server = await startServer((_req, res) => { png(res); }); }, 60_000);
afterAll(async () => { await server.close(); });

const blocked = (port: number): string[] => [
  `https://127.0.0.1:${String(port)}/`, `https://localhost:${String(port)}/`, `https://[::1]:${String(port)}/`, `https://[::ffff:127.0.0.1]:${String(port)}/`, `https://2130706433:${String(port)}/`,
  `https://169.254.169.254:${String(port)}/latest/meta-data/`, `https://10.0.0.1:${String(port)}/`, `https://192.168.0.1:${String(port)}/`, `https://172.16.0.1:${String(port)}/`,
  `https://0.0.0.0:${String(port)}/`, `https://100.64.0.1:${String(port)}/`, `https://[fe80::1]:${String(port)}/`, `https://[fd00::1]:${String(port)}/`, `https://0x7f.1:${String(port)}/`, `https://017700000001:${String(port)}/`,
];

describe('the default filter', () => {
  it.each(blocked(0))('refuses %s as blocked_address and sends nothing', async (template) => {
    const url = template.replace(':0/', `:${String(server.port)}/`);
    const before = server.seen.length;
    const result = await fetcherFor(server).fetch(url, createRemoteBudget(fetcherConfig()));
    expect(result).toEqual({ ok: false, reason: 'blocked_address' });
    expect(server.seen.length).toBe(before);
  });

  it('refuses a name that resolves to a private address (a fake resolver says so), and the server sees nothing', async () => {
    const lookup = ((_host: string, options: { all?: boolean }, cb: (e: Error | null, a: unknown, family?: number) => void) => { if (options.all === true) cb(null, [{ address: '127.0.0.1', family: 4 }]); else cb(null, '127.0.0.1', 4); }) as never;
    const before = server.seen.length;
    const result = await fetcherFor(server, { lookup }).fetch(`https://images.example:${String(server.port)}/a.png`, createRemoteBudget(fetcherConfig()));
    expect(result).toEqual({ ok: false, reason: 'blocked_address' });
    expect(server.seen.length).toBe(before);
  });

  it('every address that is blocked stays blocked when the test allow-list names only another', async () => {
    const f = fetcherFor(server, { allowLoopback: true });
    expect(await f.fetch(`https://169.254.169.254:${String(server.port)}/`, createRemoteBudget(fetcherConfig()))).toEqual({ ok: false, reason: 'blocked_address' });
  });

  it('the control: with the loopback address allowed by the test seam, the same server answers', async () => {
    const result = await fetcherFor(server, { allowLoopback: true }).fetch(`https://127.0.0.1:${String(server.port)}/a.png`, createRemoteBudget(fetcherConfig()));
    expect(result).toMatchObject({ ok: true, contentType: 'image/png' });
  });
});

function fetcherConfig() { return { fetchRemoteImages: true, remote: { maxImages: 200, maxBytes: 1_000_000, timeoutSeconds: 10, totalSeconds: 300 } }; }
