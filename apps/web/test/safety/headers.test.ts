// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script without types
import { renderHeaders } from '../../scripts/render-headers.mjs';

const script = path.resolve(import.meta.dirname, '../../scripts/render-headers.mjs');
const ORIGINS = { apiOrigin: 'https://api.example.test', collabOrigin: 'wss://collab.example.test', storeOrigin: 'https://files.example.test' };
const THIRD_PARTY = ['descopecdn.com', 'static.descope.com', 'static2.descope.com', 'cdn.jsdelivr.net', 'fpnpmcdn.net', 'accounts.google.com', 'fonts.googleapis.com'];

type Mode = 'login-document' | 'app-wide';
/** The lines of the block of one document in the rendered `headers` text, and its policy split into directives. */
function rendered(signin: Mode) {
  const out = renderHeaders({ ...ORIGINS, signin }) as { headers: string; headersJson: string; redirects: string };
  const blocks: Record<string, string[]> = {};
  let current = '';
  for (const line of out.headers.split('\n')) {
    if (line === '') continue;
    if (!line.startsWith(' ')) { current = line; blocks[current] = []; } else blocks[current]?.push(line.trim());
  }
  const policy = (document: string): Record<string, string[]> => {
    const csp = blocks[document]?.find((l) => l.startsWith('Content-Security-Policy: '))?.slice('Content-Security-Policy: '.length) ?? '';
    return Object.fromEntries(csp.split(';').map((d) => d.trim()).filter(Boolean).map((d) => { const [name, ...values] = d.split(/\s+/); return [name ?? '', values]; }));
  };
  return { out, blocks, app: policy('/index.html'), login: policy('/login.html') };
}

describe.each<Mode>(['login-document', 'app-wide'])('the rendered headers, --signin=%s', (mode) => {
  const { out, blocks, app, login } = rendered(mode);

  it('has a block for each of the two documents, the same plain headers in both, and no placeholder left', () => {
    expect(Object.keys(blocks)).toEqual(['/index.html', '/login.html']);
    for (const block of Object.values(blocks)) {
      expect(block).toEqual(expect.arrayContaining(['Referrer-Policy: no-referrer', 'X-Content-Type-Options: nosniff', 'X-Frame-Options: DENY']));
    }
    expect(out.headers + out.headersJson + out.redirects).not.toContain('{{');
  });

  it.each([['the app', () => app], ['the sign-in screen', () => login]] as const)('the policy of %s has the shared directives of the contract', (_name, policy) => {
    const p = policy();
    expect(p['default-src']).toEqual(["'none'"]);
    expect(p['base-uri']).toEqual(["'none'"]);
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

  it('has the redirects of the contract: the sign-in screen at /login, the app everywhere else', () => {
    expect(out.redirects).toBe('/login /login.html 200\n/* /index.html 200\n');
  });
});

describe('the two documents', () => {
  it('login-document: the app has no third-party origin, no unsafe-inline and no data: image; the sign-in screen has the whole list', () => {
    const { blocks, login } = rendered('login-document');
    const appLine = blocks['/index.html']?.find((l) => l.startsWith('Content-Security-Policy')) ?? '';
    for (const origin of THIRD_PARTY) expect(appLine).not.toContain(origin);
    expect(appLine).not.toContain("'unsafe-inline'");
    expect(appLine).not.toContain('data:');
    const loginLine = blocks['/login.html']?.find((l) => l.startsWith('Content-Security-Policy')) ?? '';
    for (const origin of THIRD_PARTY) expect(loginLine).toContain(origin);
    expect(login['style-src']).toContain("'unsafe-inline'");
  });

  it('app-wide: both documents carry the whole list', () => {
    const { blocks } = rendered('app-wide');
    for (const document of ['/index.html', '/login.html']) {
      const line = blocks[document]?.find((l) => l.startsWith('Content-Security-Policy')) ?? '';
      for (const origin of THIRD_PARTY) expect(line, document).toContain(origin);
    }
  });
});

describe('render-headers.mjs on the command line', () => {
  const dir = mkdtempSync(path.join(process.env['TMPDIR'] ?? tmpdir(), 'grimoire-headers-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const args = ['--api-origin', ORIGINS.apiOrigin, '--collab-origin', ORIGINS.collabOrigin, '--store-origin', ORIGINS.storeOrigin];

  it('writes headers, headers.json and redirects into --out', () => {
    execFileSync(process.execPath, [script, ...args, '--out', dir]);
    for (const name of ['headers', 'headers.json', 'redirects']) expect(readFileSync(path.join(dir, name), 'utf8').length).toBeGreaterThan(10);
  });

  it.each(['--api-origin', '--collab-origin', '--store-origin'])('exits 1 with one plain line when %s is missing', (missing) => {
    const given: string[] = [];
    for (let i = 0; i < args.length; i += 2) if (args[i] !== missing) given.push(args[i] ?? '', args[i + 1] ?? '');
    const result = spawnSync(process.execPath, [script, ...given, '--out', dir], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(`render-headers: ${missing} is required\n`);
  });

  it.each([
    [['--collab-origin', 'https://collab.example.test'], '--collab-origin must be an origin (wss: or ws: scheme'],
    [['--store-origin', 'https://files.example.test/path'], '--store-origin must be an origin'],
    [['--api-origin', 'javascript:alert(1)'], '--api-origin must be an origin'],
    [['--signin', 'everywhere'], '--signin must be login-document or app-wide'],
  ])('refuses %j', (override, message) => {
    const merged = [...args];
    for (let i = 0; i < override.length; i += 2) {
      const at = merged.indexOf(override[i] ?? '');
      if (at >= 0) merged[at + 1] = override[i + 1] ?? ''; else merged.push(override[i] ?? '', override[i + 1] ?? '');
    }
    const result = spawnSync(process.execPath, [script, ...merged, '--out', dir], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
  });
});
