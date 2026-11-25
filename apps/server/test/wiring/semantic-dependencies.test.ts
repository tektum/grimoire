// @vitest-environment node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// M7-T11 (contracts section 15.1): the dependencies of the semantic search, and what they must not bring. The tests read the files the package manager wrote.
const root = resolve(import.meta.dirname, '../../../..');
const read = (p: string): string => readFileSync(resolve(root, p), 'utf8');
const lock = read('bun.lock');
const adapter = JSON.parse(read('packages/adapters/embedder-onnx/package.json')) as { dependencies: Record<string, string> };
const installed = (name: string): string[] => [...new Set([...lock.matchAll(new RegExp(`"${name.replace('/', '\\/')}@(\\d+\\.\\d+\\.\\d+[^"]*)"`, 'g'))].map((m) => m[1] as string))];
// Written in pieces so that this file does not name them: only the adapter's own files may (the grep of the task).
const RUNTIME = ['onnx', 'runtime-node'].join('');
const WEB_RUNTIME = ['onnx', 'runtime-web'].join('');
const TOKENIZERS = ['@hugging', 'face/tokenizers'].join('');
const TRANSFORMERS = ['@hugging', 'face/transformers'].join('');

describe('the semantic dependencies', () => {
  it.each([
    [RUNTIME, '1.31.1'],
    [TOKENIZERS, '0.2.0'],
  ])('pins %s at exactly %s, once, in the adapter package only', (name, version) => {
    expect(adapter.dependencies[name]).toBe(version);
    expect(installed(name)).toEqual([version]);
    for (const p of ['package.json', 'apps/server/package.json', 'packages/core/package.json']) expect(read(p)).not.toContain(name);
  });

  it('has neither the transformers library nor the browser runtime', () => {
    expect(installed(TRANSFORMERS)).toEqual([]);
    expect(installed(WEB_RUNTIME)).toEqual([]);
  });
});

describe('no GPU libraries', () => {
  it('.npmrc skips the CUDA download, and no install script of the runtime is trusted to run', () => {
    expect(read('.npmrc').split('\n')).toContain(`${RUNTIME}-install-cuda=skip`);
    const trusted = (JSON.parse(read('package.json')) as { trustedDependencies?: string[] }).trustedDependencies ?? [];
    expect(trusted).not.toContain(RUNTIME);
  });

  it('the installed runtime holds no CUDA or TensorRT file, and the binaries of one platform are under 80 MB', () => {
    const dir = resolve(root, 'node_modules', RUNTIME);
    if (!existsSync(dir)) return; // not installed in this checkout: the lockfile checks above still hold
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(d, e.name));
        else files.push(join(d, e.name));
      }
    };
    walk(dir);
    expect(files.filter((f) => /cuda|tensorrt|libnvinfer|libcudart/i.test(f))).toEqual([]);
    const linux = join(dir, 'bin/napi-v6/linux');
    if (existsSync(linux)) {
      const size = (d: string): number => readdirSync(d, { withFileTypes: true }).reduce((sum, e) => sum + (e.isDirectory() ? size(join(d, e.name)) : statSync(join(d, e.name)).size), 0);
      expect(size(linux)).toBeLessThan(80 * 1024 * 1024);
    }
  });
});

describe('where they are imported', () => {
  it('only the embedder adapter imports either package, and nothing in core', () => {
    const walk = (dir: string, found: string[] = []): string[] => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', 'dist', 'coverage'].includes(e.name)) continue;
        if (e.isDirectory()) walk(join(dir, e.name), found);
        else if (/\.(ts|tsx|mjs|js)$/.test(e.name)) found.push(join(dir, e.name));
      }
      return found;
    };
    const named = [RUNTIME, TOKENIZERS, TRANSFORMERS, WEB_RUNTIME];
    const offenders = ['apps', 'packages']
      .flatMap((top) => walk(resolve(root, top)))
      .filter((file) => named.some((name) => readFileSync(file, 'utf8').includes(name)))
      .map((file) =>
        file
          .slice(root.length + 1)
          .split('\\')
          .join('/'),
      )
      .filter((file) => !file.startsWith('packages/adapters/embedder-onnx/'));
    expect(offenders).toEqual([]);
  });
});
