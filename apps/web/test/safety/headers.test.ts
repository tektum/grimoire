// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script without types
import { renderHeaders } from '../../scripts/render-headers.mjs';

const script = path.resolve(import.meta.dirname, '../../scripts/render-headers.mjs');
const ORIGINS = { apiOrigin: 'https://api.example.test', collabOrigin: 'wss://collab.example.test', storeOrigin: 'https://files.example.test' };
const THIRD_PARTY = ['descopecdn.com', 'static.descope.com', 'static2.descope.com', 'cdn.jsdelivr.net', 'fpnpmcdn.net', 'accounts.google.com', 'fonts.googleapis.com'];

type Mode = 'login-document' | 'app-wide';
type Rendered = Record<string, string[]>;
const render = (over: Record<string, string> = {}): Rendered => JSON.parse((renderHeaders({ ...ORIGINS, ...over }) as { headersJson: string }).headersJson) as Rendered;

/** The policy of one document split into directives. */
function policyOf(lines: Rendered, document: string): Record<string, string[]> {
  const csp = lines[document]?.find((l) => l.startsWith('Content-Security-Policy: '))?.slice('Content-Security-Policy: '.length) ?? '';
  return Object.fromEntries(csp.split(';').map((d) => d.trim()).filter(Boolean).map((d) => { const [name, ...values] = d.split(/\s+/); return [name ?? '', values]; }));
}
const lineOf = (lines: Rendered, document: string): string => lines[document]?.find((l) => l.startsWith('Content-Security-Policy')) ?? '';

describe.each<Mode>(['login-document', 'app-wide'])('the rendered headers, --signin=%s', (mode) => {
  const lines = render({ signin: mode });
  const app = policyOf(lines, '/index.html');
  const login = policyOf(lines, '/login.html');

  it('has the two documents, the same plain headers in both, and no placeholder left', () => {
    expect(Object.keys(lines)).toEqual(['/index.html', '/login.html']);
    for (const block of Object.values(lines)) {
      expect(block).toEqual(expect.arrayContaining(['Referrer-Policy: no-referrer', 'X-Content-Type-Options: nosniff', 'X-Frame-Options: DENY']));
    }
    expect(JSON.stringify(lines)).not.toContain('{{');
  });

  it.each([['the app', () => app], ['the sign-in screen', () => login]] as const)('the policy of %s has the shared directives', (_name, policy) => {
    const p = policy();
    expect(p['default-src']).toEqual(["'none'"]);
    expect(p['base-uri']).toEqual(["'self'"]); // both documents have <base href="/">, which a deep link such as /p/page-x needs to find /assets/
    expect(p['object-src']).toEqual(["'none'"]);
    expect(p['form-action']).toEqual(["'self'"]);
    expect(p['frame-ancestors']).toEqual(["'none'"]);
    expect(p['script-src']).not.toContain("'unsafe-inline'");
    expect(p['script-src']).not.toContain("'unsafe-eval'");
  });

  it('lets the app reach its API, the collaboration socket with its scheme written out, the identity provider and the store, and shows images from the store', () => {
    expect(app['connect-src']).toEqual(expect.arrayContaining(["'self'", ORIGINS.apiOrigin, ORIGINS.collabOrigin, ORIGINS.storeOrigin, 'https://api.descope.com']));
    expect(app['img-src']).toEqual(expect.arrayContaining(["'self'", ORIGINS.storeOrigin]));
    expect(app['connect-src']?.filter((v) => v.startsWith('ws'))).toEqual([ORIGINS.collabOrigin]);
  });
});

describe('the two documents', () => {
  it('login-document: the app has no third-party origin, no unsafe-inline and no data: image; the sign-in screen has the whole list', () => {
    const lines = render();
    const appLine = lineOf(lines, '/index.html');
    for (const origin of THIRD_PARTY) expect(appLine).not.toContain(origin);
    expect(appLine).not.toContain("'unsafe-inline'");
    expect(appLine).not.toContain('data:');
    for (const origin of THIRD_PARTY) expect(lineOf(lines, '/login.html')).toContain(origin);
    expect(policyOf(lines, '/login.html')['style-src']).toContain("'unsafe-inline'");
  });

  it('app-wide: both documents carry the whole list', () => {
    const lines = render({ signin: 'app-wide' });
    for (const document of ['/index.html', '/login.html']) for (const origin of THIRD_PARTY) expect(lineOf(lines, document), document).toContain(origin);
  });
});

describe('the identity provider of a regional project', () => {
  it('replaces https://api.descope.com in the connect-src of both policies, and nothing else changes', () => {
    const regional = render({ descopeOrigin: 'https://api.use1.descope.test' });
    const plain = render();
    for (const document of ['/index.html', '/login.html']) {
      const connect = policyOf(regional, document)['connect-src'];
      expect(connect).toContain('https://api.use1.descope.test');
      expect(connect).not.toContain('https://api.descope.com');
      expect(lineOf(regional, document).replace('https://api.use1.descope.test', 'https://api.descope.com')).toBe(lineOf(plain, document));
    }
  });
});

describe('what the renderer accepts as an origin', () => {
  it('accepts an explicit default port, and http(s)/ws(s) only on loopback for local development', () => {
    expect(policyOf(render({ apiOrigin: 'https://api.example.test:443' }), '/index.html')['connect-src']).toContain('https://api.example.test');
    const local = render({ apiOrigin: 'http://127.0.0.1:8080', collabOrigin: 'ws://localhost:8080', storeOrigin: 'http://127.0.0.1:8333' });
    expect(policyOf(local, '/index.html')['connect-src']).toEqual(expect.arrayContaining(['http://127.0.0.1:8080', 'ws://localhost:8080', 'http://127.0.0.1:8333']));
  });

  it.each([
    [{ apiOrigin: 'http://api.example.test' }, '--api-origin must be an origin'],
    [{ storeOrigin: 'http://files.example.test' }, '--store-origin must be an origin'],
    [{ collabOrigin: 'ws://collab.example.test' }, '--collab-origin must be an origin'],
    [{ apiOrigin: 'https://api.example.test/path' }, '--api-origin must be an origin'],
    [{ apiOrigin: 'https://user:pass@api.example.test' }, '--api-origin must be an origin'],
    [{ apiOrigin: 'https://api.example.test; img-src *' }, '--api-origin must be an origin'],
    [{ descopeOrigin: 'http://127.0.0.1:1' }, '--descope-origin must be an origin'],
    [{ fingerprintConnect: 'https://fp.example.test; img-src *' }, '--fingerprint-connect must be an origin'],
    [{ fingerprintConnect: 'https://fp.example.test\nX-Injected: 1' }, '--fingerprint-connect must be an origin'],
    [{ fingerprintConnect: 'http://fp.example.test' }, '--fingerprint-connect must be an origin'],
  ])('refuses %j', (over, message) => {
    expect(() => renderHeaders({ ...ORIGINS, ...over })).toThrow(message);
  });

  it('puts the hosts of --fingerprint-connect into connect-src of the sign-in policy, each checked', () => {
    const lines = render({ fingerprintConnect: 'https://fp1.example.test https://fp2.example.test' });
    expect(policyOf(lines, '/login.html')['connect-src']).toEqual(expect.arrayContaining(['https://fp1.example.test', 'https://fp2.example.test']));
    expect(policyOf(lines, '/index.html')['connect-src']).not.toContain('https://fp1.example.test');
  });
});

describe('render-headers.mjs on the command line', () => {
  const dir = mkdtempSync(path.join(process.env['TMPDIR'] ?? tmpdir(), 'grimoire-headers-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const args = ['--api-origin', ORIGINS.apiOrigin, '--collab-origin', ORIGINS.collabOrigin, '--store-origin', ORIGINS.storeOrigin];

  it('writes headers.json into --out, and no file for a static host', () => {
    execFileSync(process.execPath, [script, ...args, '--out', dir]);
    expect(readFileSync(path.join(dir, 'headers.json'), 'utf8').length).toBeGreaterThan(10);
    for (const name of ['headers', 'redirects', '_headers', '_redirects']) expect(existsSync(path.join(dir, name)), name).toBe(false);
  });

  it.each(['--api-origin', '--collab-origin', '--store-origin'])('exits 1 with one plain line when %s is missing', (missing) => {
    const given: string[] = [];
    for (let i = 0; i < args.length; i += 2) if (args[i] !== missing) given.push(args[i] ?? '', args[i + 1] ?? '');
    const result = spawnSync(process.execPath, [script, ...given, '--out', dir], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(`render-headers: ${missing} is required\n`);
  });

  it('exits 1 for a bad --signin, a bad regional origin and a bad fingerprint host', () => {
    for (const extra of [['--signin', 'everywhere'], ['--descope-origin', 'javascript:alert(1)'], ['--fingerprint-connect', 'https://fp.example.test; img-src *']]) {
      const result = spawnSync(process.execPath, [script, ...args, ...extra, '--out', dir], { encoding: 'utf8' });
      expect([result.status, result.stderr.startsWith('render-headers: --')]).toEqual([1, true]);
    }
  });
});
