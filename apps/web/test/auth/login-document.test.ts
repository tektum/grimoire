// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script without types
import { checkBuild, withoutOwnDescopeUses } from '../../scripts/check-build.mjs';
// @ts-expect-error plain .mjs script without types
import { createServer } from '../../scripts/serve.mjs';

const web = path.resolve(import.meta.dirname, '../..');
const dirs: string[] = [];
const build = (mode: string): string => {
  const out = mkdtempSync(path.join(tmpdir(), `grimoire-${mode}-`));
  dirs.push(out);
  execFileSync(process.execPath, [path.join(web, '../../node_modules/vite/bin/vite.js'), 'build', '--mode', mode, '--outDir', out, '--emptyOutDir'], { cwd: web, stdio: 'pipe' });
  return out;
};
const files = (dir: string, ext: string) => readdirSync(path.join(dir, 'assets')).filter((f) => f.endsWith(ext));
const read = (dir: string, file: string) => readFileSync(path.join(dir, file), 'utf8');

let production: string;
let e2e: string;
beforeAll(() => {
  production = build('production');
  e2e = build('e2e');
}, 120_000);
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** The chunks one document loads at start: its scripts, and what they import statically. */
function loadedBy(dist: string, document: string): string[] {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file) || !file.endsWith('.js')) return;
    seen.add(file);
    for (const m of read(dist, `assets/${file}`).matchAll(/(?:from|import)\s*["']\.\/([^"']+\.js)["']/g)) visit(m[1]!);
  };
  for (const m of read(dist, document).matchAll(/src="(?:\.\/)?assets\/([^"]+\.js)"/g)) visit(m[1]!);
  return [...seen];
}

describe('the two documents of the build', () => {
  it('has login.html and index.html, each with its own entry script, and check-build accepts the build in both modes', () => {
    for (const dist of [production, e2e]) {
      expect(read(dist, 'login.html')).toMatch(/src="\.\/assets\/login-[^"]+\.js"/);
      expect(read(dist, 'index.html')).toMatch(/src="\.\/assets\/index-[^"]+\.js"/);
      expect(read(dist, 'login.html')).toContain('<base href="/"');
      // An e2e build has the development sign-in and the design sample by design; those are the only two things the check may report on it.
      expect(checkBuild(dist).filter((p: string) => dist === production || !/grimoire-dev-signin|grimoire-design-sample/.test(p))).toEqual([]);
    }
  });

  it('keeps the identity provider and the fingerprinting script out of everything index.html loads, and lists what the sign-in document loads', () => {
    for (const dist of [production, e2e]) {
      for (const chunk of loadedBy(dist, 'index.html')) {
        const text = read(dist, `assets/${chunk}`);
        // What remains of the word after the app's own uses (its loader's name, the chunk file names in its preload list, the label of a session's method) is the provider's code.
        expect([chunk, withoutOwnDescopeUses(text).toLowerCase().includes('descope')]).toEqual([chunk, false]);
        for (const word of ['fingerprint', 'fpnpmcdn', 'descopecdn']) expect([chunk, word, text.toLowerCase().includes(word)]).toEqual([chunk, word, false]);
      }
    }
    // The provider's code is in chunks only the sign-in document (or a dynamic import) reaches.
    const withProvider = files(production, '.js').filter((f) =>
      withoutOwnDescopeUses(read(production, `assets/${f}`))
        .toLowerCase()
        .includes('descope'),
    );
    expect(withProvider.length).toBeGreaterThan(0);
    const startOfIndex = new Set(loadedBy(production, 'index.html'));
    for (const chunk of withProvider) expect([chunk, startOfIndex.has(chunk)]).toEqual([chunk, false]);
  });

  it("takes out only the app's own uses of the word, never the provider's code", () => {
    const own = 'loadDescope:async()=>(await p(()=>import("./descope-sdk-DKyABvbD.js")))' + ',{status:`signed-in`,method:`descope`},"./descope-signin-Abc_12.js"';
    expect(withoutOwnDescopeUses(own).toLowerCase()).not.toContain('descope');
    // A quoted word on its own, outside the one property the app writes it in, is not the app's: provider code could hide behind it.
    for (const theirs of [
      '"descope"',
      '`descope`',
      "'descope'",
      '{label:"descope"}',
      '{kind:`descope`}',
      '"x-descope-sdk-name"',
      '"x-descope-sdk-version"',
      'DescopeSDK',
      'descopeProjectId',
      '"descope-wc"',
    ])
      expect([theirs, withoutOwnDescopeUses(theirs).toLowerCase().includes('descope')]).toEqual([theirs, true]);
  });

  it('has no origin of the provider written as a script address in the entry chunks of index.html', () => {
    for (const chunk of loadedBy(production, 'index.html')) expect(read(production, `assets/${chunk}`)).not.toMatch(/https?:\/\/[^"'\s]*(?:descope|fpnpmcdn|jsdelivr)/i);
  });

  it('has no development sign-in in a production build, and has it in an e2e build', () => {
    expect(files(production, '.js').filter((f) => read(production, `assets/${f}`).includes('grimoire-dev-signin'))).toEqual([]);
    expect(files(e2e, '.js').filter((f) => read(e2e, `assets/${f}`).includes('grimoire-dev-signin')).length).toBe(1);
    expect(read(production, 'login.html')).not.toContain('DevSignInForm');
  });

  it('puts the sign-in text for a local server in the production sign-in chunk', () => {
    const chunks = files(production, '.js').map((f) => read(production, `assets/${f}`));
    expect(chunks.some((c) => c.includes('This server is in local development mode; sign-in is unavailable in this build'))).toBe(true);
  });
});

describe('/login is the sign-in document', () => {
  let server: http.Server;
  let origin: string;
  beforeAll(async () => {
    server = createServer({ dist: production });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => void server.close());

  it('is served as login.html by scripts/serve.mjs, query string kept, and every other path as the app', async () => {
    const login = await (await fetch(`${origin}/login?return=%2Fp%2Fx`)).text();
    expect(login).toBe(read(production, 'login.html'));
    expect(await (await fetch(`${origin}/p/some-page-ab12cd/history`)).text()).toBe(read(production, 'index.html'));
    expect(await (await fetch(`${origin}/login.html`)).text()).toBe(read(production, 'login.html'));
  });
});
