// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script without types
import { createServer } from '../../scripts/serve.mjs';

const root = mkdtempSync(path.join(process.env['TMPDIR'] ?? tmpdir(), 'grimoire-serve-headers-'));
const dist = path.join(root, 'dist');
const rendered = path.join(root, 'rendered');
const script = path.resolve(import.meta.dirname, '../../scripts/render-headers.mjs');
const servers: Server[] = [];

async function start(options: { headersDir?: string }): Promise<string> {
  const server = createServer({ dist, ...options }) as Server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}
const headersOf = async (base: string, pathname: string): Promise<Headers> => (await fetch(`${base}${pathname}`)).headers;

beforeAll(() => {
  mkdirSync(dist, { recursive: true });
  writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>app</title>');
  writeFileSync(path.join(dist, 'login.html'), '<!doctype html><title>login</title>');
  execFileSync(process.execPath, [script, '--api-origin', 'https://api.example.test', '--collab-origin', 'wss://api.example.test', '--store-origin', 'https://files.example.test', '--out', rendered]);
});
afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
  rmSync(root, { recursive: true, force: true });
});

describe('scripts/serve.mjs with rendered headers', () => {
  it('gives each document the policy of its own block: the narrow one to the app and its deep links, the full one to /login', async () => {
    const base = await start({ headersDir: rendered });
    const app = (await headersOf(base, '/')).get('content-security-policy') ?? '';
    expect(app).toContain("script-src 'self';");
    expect(app).not.toContain('descopecdn.com');
    expect((await headersOf(base, '/p/some-page-ab12cd')).get('content-security-policy')).toBe(app);
    const login = (await headersOf(base, '/login?return=%2F')).get('content-security-policy') ?? '';
    expect(login).toContain('https://descopecdn.com');
    expect(login).not.toBe(app);
    const plain = await headersOf(base, '/login');
    expect([plain.get('referrer-policy'), plain.get('x-content-type-options'), plain.get('x-frame-options')]).toEqual(['no-referrer', 'nosniff', 'DENY']);
  });

  it.each([
    ['a missing document', (json: Record<string, string[]>) => { delete json['/login.html']; }],
    ['an empty document', (json: Record<string, string[]>) => { json['/index.html'] = []; }],
    ['a document without a policy', (json: Record<string, string[]>) => { json['/index.html'] = ['Referrer-Policy: no-referrer']; }],
    ['a line that is not a header', (json: Record<string, string[]>) => { json['/login.html'] = ['Content-Security-Policy: x', 'garbage']; }],
  ])('refuses to start from a headers.json with %s, instead of serving a document with no policy', (_name, damage) => {
    const partial = path.join(root, `partial-${String(servers.length)}-${_name.replaceAll(' ', '-')}`);
    mkdirSync(partial, { recursive: true });
    const json = JSON.parse(readFileSync(path.join(rendered, 'headers.json'), 'utf8')) as Record<string, string[]>;
    damage(json);
    writeFileSync(path.join(partial, 'headers.json'), JSON.stringify(json));
    expect(() => createServer({ dist, headersDir: partial })).toThrow(/no usable header lines, with a content security policy/);
  });

  it('without a headers directory sets only the plain headers, and says so when the directory has no headers.json', async () => {
    const base = await start({});
    const headers = await headersOf(base, '/');
    expect(headers.get('content-security-policy')).toBeNull();
    expect(headers.get('referrer-policy')).toBe('no-referrer');
    expect(() => createServer({ dist, headersDir: path.join(root, 'nowhere') })).toThrow(/no headers\.json/);
  });
});
