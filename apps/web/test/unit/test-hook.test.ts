// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const web = path.resolve(import.meta.dirname, '../..');
const cache = path.join(web, 'node_modules/.cache');
const dirs: string[] = [];
const build = (mode: string): string => {
  mkdirSync(cache, { recursive: true });
  const out = mkdtempSync(path.join(cache, `test-hook-${mode}-`));
  dirs.push(out);
  execFileSync(process.execPath, [path.join(web, '../../node_modules/vite/bin/vite.js'), 'build', '--mode', mode, '--outDir', out, '--emptyOutDir'], {
    cwd: web,
    stdio: 'pipe',
    env: { ...process.env, NODE_ENV: 'production' },
  });
  return out;
};
const chunks = (dir: string): string[] =>
  readdirSync(path.join(dir, 'assets'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => readFileSync(path.join(dir, 'assets', f), 'utf8'));

let production: string;
let e2e: string;
beforeAll(() => {
  production = build('production');
  e2e = build('e2e');
}, 120_000);
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("the test hook that puts the open page's shared document on the window", () => {
  it('is in the end-to-end build, where the specifications read it', () => {
    expect(chunks(e2e).some((text) => text.includes('__grimoireDoc'))).toBe(true);
  });

  it('is not in the production build: no chunk has it', () => {
    expect(chunks(production).filter((text) => text.includes('__grimoireDoc'))).toEqual([]);
  });
});
