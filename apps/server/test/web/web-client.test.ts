import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeFakeConfig } from '@tektum/grimoire-core/testing/fake-config';
import { createApp } from '../../src/app.js';
import { renderDocumentHeaders, webOrigins } from '../../src/web/headers.js';
import { makeContext } from '../server/support/context.js';

const repo = path.resolve(import.meta.dirname, '../../../..');
const TEMPLATE = path.join(repo, 'apps/web/headers/headers.template');
const INDEX = '<!doctype html><title>app</title>';
const LOGIN = '<!doctype html><title>login</title>';
const ASSET = 'console.log("app");';
const FILES = { endpoint: 'http://s3.invalid', publicEndpoint: 'https://files.example.test', publicOrigin: 'https://files.example.test', bucket: 'b', region: 'r', addressing: 'virtual' as const, createOnlyHeader: 'if-none-match' as const, corsMode: 'external' as const, maxBytes: 1000, allowedTypes: ['image/png'], pendingMaxPerUser: 10 };
let root: string;

const build = (over: Record<string, unknown> = {}) => {
  const t = makeContext();
  return createApp({ ...t.ctx, config: makeFakeConfig({ webRoot: root, publicApiUrl: 'https://grimoire.example.test', publicCollabUrl: 'https://grimoire.example.test/collab', files: FILES, ...over }) });
};

beforeAll(() => {
  root = mkdtempSync(path.join(process.env['TMPDIR'] ?? tmpdir(), 'grimoire-web-'));
  mkdirSync(path.join(root, 'dist/assets'), { recursive: true });
  writeFileSync(path.join(root, 'dist/index.html'), INDEX);
  writeFileSync(path.join(root, 'dist/login.html'), LOGIN);
  writeFileSync(path.join(root, 'dist/assets/index-abcd1234.js'), ASSET);
  writeFileSync(path.join(root, 'dist/robots.txt'), 'User-agent: *\n');
  writeFileSync(path.join(root, 'secret.txt'), 'outside the build');
  copyFileSync(TEMPLATE, path.join(root, 'headers.template'));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('the web client served by the server', () => {
  it('serves the app at / and at any route of the app, the sign-in document at /login, each with its own policy and the plain headers', async () => {
    const app = build();
    const home = await app.request('/');
    expect(home.status).toBe(200);
    expect(await home.text()).toBe(INDEX);
    expect(home.headers.get('content-type')).toContain('text/html');
    const policy = home.headers.get('content-security-policy') ?? '';
    expect(policy).toContain("script-src 'self';");
    expect(policy).not.toContain('descopecdn.com');
    for (const route of ['/p/some-page-ab12cd', '/c/handbook', '/admin/groups']) {
      const res = await app.request(route);
      expect([res.status, await res.text(), res.headers.get('content-security-policy')]).toEqual([200, INDEX, policy]);
    }
    const login = await app.request('/login?return=%2Fp%2Fx');
    expect(await login.text()).toBe(LOGIN);
    expect(login.headers.get('content-security-policy')).toContain('https://descopecdn.com');
    for (const res of [home, login]) {
      expect([res.headers.get('referrer-policy'), res.headers.get('x-content-type-options'), res.headers.get('x-frame-options'), res.headers.get('cache-control')]).toEqual(['no-referrer', 'nosniff', 'DENY', 'no-cache']);
      expect(policy).toContain("frame-ancestors 'none'");
    }
  });

  it('keeps its own X-Frame-Options and policy: the defaults the API gets are not laid over the documents', async () => {
    const api = await build().request('/healthz');
    expect(api.status).toBe(200);
    expect(api.headers.get('content-security-policy')).toBeNull();
    expect(api.headers.get('x-frame-options')).toBe('SAMEORIGIN'); // the defaults still cover the API
    expect((await build().request('/')).headers.get('x-frame-options')).toBe('DENY');
  });

  it('serves hashed assets for a year and other files revalidated, and a missing file is a 404, never the app', async () => {
    const app = build();
    const asset = await app.request('/assets/index-abcd1234.js');
    expect([asset.status, await asset.text(), asset.headers.get('cache-control')]).toEqual([200, ASSET, 'public, max-age=31536000, immutable']);
    expect(asset.headers.get('x-content-type-options')).toBe('nosniff');
    const robots = await app.request('/robots.txt');
    expect([robots.status, robots.headers.get('cache-control')]).toEqual([200, 'no-cache']);
    const missing = await app.request('/assets/nothing-12345678.js');
    expect(missing.status).toBe(404);
    expect(await missing.text()).not.toContain('<title>');
  });

  it('makes /config.json from the public API address, never cached', async () => {
    const res = await build().request('/config.json');
    expect([res.status, await res.json(), res.headers.get('cache-control')]).toEqual([200, { apiUrl: 'https://grimoire.example.test' }, 'no-store']);
  });

  it('answers HEAD without a body, and leaves every other method and the API to the API', async () => {
    const app = build();
    const head = await app.request('/', { method: 'HEAD' });
    expect([head.status, await head.text(), head.headers.get('content-security-policy') === null]).toEqual([200, '', false]);
    for (const method of ['POST', 'PUT', 'DELETE']) expect((await app.request('/p/x', { method })).status, method).toBe(404);
    const api = await app.request('/v1/not-a-route'); // the API's own answer (it asks for a sign-in first), never the app
    expect(api.status).toBe(401);
    expect(await api.text()).not.toContain('<title>');
  });

  it.each(['/../secret.txt', '/assets/../../secret.txt', '/%2e%2e/secret.txt', '/assets/%2e%2e/%2e%2e/secret.txt', '/..%5csecret.txt'])('does not serve a file outside the build: %s', async (route) => {
    const res = await build().request(route);
    expect(await res.text()).not.toContain('outside the build');
  });

  it('serves nothing without a web root: the API only, as before', async () => {
    const res = await build({ webRoot: undefined }).request('/');
    expect(res.status).toBe(404);
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
  });

  it('refuses to start from an incomplete build, naming the file', () => {
    expect(() => build({ webRoot: path.join(root, 'dist') })).toThrow(/web client is incomplete: .*headers\.template is missing|index\.html is missing/);
  });
});

describe('the headers the server renders', () => {
  it('are the lines scripts/render-headers.mjs renders for a static host, in both modes', () => {
    const origins = webOrigins({ apiUrl: 'https://grimoire.example.test', collabUrl: 'https://grimoire.example.test/collab', storeOrigin: 'https://files.example.test' });
    expect(origins).toEqual({ apiOrigin: 'https://grimoire.example.test', collabOrigin: 'wss://grimoire.example.test', storeOrigin: 'https://files.example.test', descopeOrigin: 'https://api.descope.com' });
    for (const signin of ['login-document', 'app-wide'] as const) {
      const out = path.join(root, `rendered-${signin}`);
      execFileSync(process.execPath, [path.join(repo, 'apps/web/scripts/render-headers.mjs'), '--api-origin', origins.apiOrigin, '--collab-origin', origins.collabOrigin, '--store-origin', origins.storeOrigin, '--descope-origin', origins.descopeOrigin, '--signin', signin, '--out', out]);
      const fromScript = JSON.parse(readFileSync(path.join(out, 'headers.json'), 'utf8')) as Record<string, string[]>;
      expect(renderDocumentHeaders(readFileSync(TEMPLATE, 'utf8'), origins, signin), signin).toEqual(fromScript);
    }
  });

  it('use the regional identity provider of a project, as the script does', () => {
    const origins = webOrigins({ apiUrl: 'https://grimoire.example.test', collabUrl: 'https://grimoire.example.test', storeOrigin: 'https://files.example.test', descopeUrl: 'https://api.use1.descope.test/' });
    expect(origins.descopeOrigin).toBe('https://api.use1.descope.test');
    expect(renderDocumentHeaders(readFileSync(TEMPLATE, 'utf8'), origins)['/index.html'].join('\n')).toContain('https://api.use1.descope.test');
  });

  it('take an explicit default port, plain http and ws only on loopback, and refuse what is not exactly an origin', () => {
    expect(webOrigins({ apiUrl: 'https://grimoire.example.test:443', collabUrl: 'https://grimoire.example.test', storeOrigin: 'https://files.example.test' }).apiOrigin).toBe('https://grimoire.example.test');
    const local = webOrigins({ apiUrl: 'http://127.0.0.1:8080', collabUrl: 'http://localhost:8080', storeOrigin: 'http://[::1]:8333' });
    expect([local.apiOrigin, local.collabOrigin, local.storeOrigin]).toEqual(['http://127.0.0.1:8080', 'ws://localhost:8080', 'http://[::1]:8333']);
    expect(() => webOrigins({ apiUrl: 'http://grimoire.example.test', collabUrl: 'https://c.test', storeOrigin: 'https://s.test' })).toThrow(/public API address/);
    expect(() => webOrigins({ apiUrl: 'https://a.test', collabUrl: 'https://c.test', storeOrigin: 'http://files.example.test' })).toThrow(/file store address/);
    expect(() => webOrigins({ apiUrl: 'https://a.test', collabUrl: 'https://c.test', storeOrigin: 'https://s.test', descopeUrl: 'http://127.0.0.1:1' })).toThrow(/identity provider address/);
    expect(() => webOrigins({ apiUrl: 'https://u:p@a.test', collabUrl: 'https://c.test', storeOrigin: 'https://s.test' })).toThrow(/public API address/);
  });

  it('turn an http(s) live editing address into the ws(s) origin and refuse an address that is not an origin of a web scheme', () => {
    expect(webOrigins({ apiUrl: 'http://127.0.0.1:8080/', collabUrl: 'http://127.0.0.1:8080', storeOrigin: 'http://127.0.0.1:8333' }).collabOrigin).toBe('ws://127.0.0.1:8080');
    expect(() => webOrigins({ apiUrl: 'ftp://x', collabUrl: 'https://c.test', storeOrigin: 'https://s.test' })).toThrow(/public API address/);
    expect(() => webOrigins({ apiUrl: 'https://a.test', collabUrl: 'https://c.test', storeOrigin: 'not a url' })).toThrow(/file store address/);
  });
});
