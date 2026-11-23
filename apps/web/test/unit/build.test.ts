// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script without types
import { checkBuild } from '../../scripts/check-build.mjs';
// @ts-expect-error plain .mjs script without types
import { parseHeaders } from '../../scripts/serve.mjs';

const web = path.resolve(import.meta.dirname, '../..');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A small build in a temporary directory: index.html loading assets/index.js, plus the given extra files. */
function fakeBuild(files: Record<string, string> = {}, { config = true }: { config?: boolean } = {}): string {
  const dist = mkdtempSync(path.join(tmpdir(), 'grimoire-dist-'));
  dirs.push(dist);
  mkdirSync(path.join(dist, 'assets'));
  writeFileSync(path.join(dist, 'index.html'), '<!doctype html><script type="module" src="./assets/index.js"></script>');
  writeFileSync(path.join(dist, 'assets/index.js'), 'console.log("app")');
  if (config) writeFileSync(path.join(dist, 'config.json'), '{}');
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dist, name)), { recursive: true });
    writeFileSync(path.join(dist, name), text);
  }
  return dist;
}

describe('check-build', () => {
  it('accepts a build that is as required', () => {
    expect(checkBuild(fakeBuild())).toEqual([]);
  });
  it.each(['descope', 'fingerprint', 'fpnpmcdn'])('fails when a chunk loaded by index.html contains %s, also through a static import', (word) => {
    expect(checkBuild(fakeBuild({ 'assets/index.js': `/* ${word} */` })).join('\n')).toContain(word);
    const viaImport = fakeBuild({ 'assets/index.js': 'import"./vendor.js";', 'assets/vendor.js': `var x="${word.toUpperCase()}"` });
    expect(checkBuild(viaImport).join('\n')).toContain('vendor.js');
  });
  it('accepts those words in a chunk that only a dynamic import loads (the sign-in page)', () => {
    expect(checkBuild(fakeBuild({ 'assets/index.js': 'import("./login.js")', 'assets/login.js': 'descope fingerprint fpnpmcdn' }))).toEqual([]);
  });
  it('fails on the development sign-in marker in any chunk', () => {
    expect(checkBuild(fakeBuild({ 'assets/login.js': 'grimoire-dev-signin' })).join('\n')).toContain('grimoire-dev-signin');
  });
  it('fails on an absolute /assets/ path in index.html or in a chunk', () => {
    const html = fakeBuild({ 'index.html': '<script type="module" src="/assets/index.js"></script>' });
    expect(checkBuild(html).join('\n')).toContain('index.html has an absolute /assets/ path');
    const chunk = fakeBuild({ 'assets/index.js': 'import("/assets/other.js")' });
    expect(checkBuild(chunk).join('\n')).toContain('assets/index.js has an absolute');
  });
  it('fails when config.json or index.html is missing', () => {
    expect(checkBuild(fakeBuild({}, { config: false })).join('\n')).toContain('config.json is missing');
    const none = mkdtempSync(path.join(tmpdir(), 'grimoire-dist-'));
    dirs.push(none);
    expect(checkBuild(none).join('\n')).toContain('index.html is missing');
  });
  it('exits 1 with a message from the command line, 0 when ok', () => {
    const run = (dist: string) => {
      try {
        return { code: 0, out: execFileSync('node', [path.join(web, 'scripts/check-build.mjs'), dist], { encoding: 'utf8', stdio: 'pipe' }) };
      } catch (e) {
        const err = e as { status: number; stderr: string };
        return { code: err.status, out: err.stderr };
      }
    };
    expect(run(fakeBuild())).toEqual({ code: 0, out: 'check-build: ok\n' });
    const bad = run(fakeBuild({}, { config: false }));
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('config.json is missing');
  });
});

describe('headers.template', () => {
  const text = readFileSync(path.join(web, 'headers/headers.template'), 'utf8');
  it('has Referrer-Policy: no-referrer exactly once and nosniff, for every path', () => {
    expect(text.split('\n').filter((l) => l.includes('Referrer-Policy: no-referrer'))).toHaveLength(1);
    expect(parseHeaders(text)).toEqual({ 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
  });
  it('is read as a _headers file: only the /* block applies, comments are ignored', () => {
    expect(parseHeaders('# c\n/other\n  A: 1\n/*\n  B: two: parts\n')).toEqual({ B: 'two: parts' });
  });
});
