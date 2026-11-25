import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// What the semantic search may bring into the tree (M7-T11, T12): two runtime packages at exact versions, in one adapter only, with no GPU libraries.
const root = path.resolve(import.meta.dirname, '../../../..');
const read = (file: string): string => readFileSync(path.join(root, file), 'utf8');
const sizeOf = (dir: string): number => readdirSync(dir, { withFileTypes: true }).reduce((sum, e) => sum + (e.isDirectory() ? sizeOf(path.join(dir, e.name)) : statSync(path.join(dir, e.name)).size), 0);
const walk = (dir: string, found: string[] = []): string[] => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'coverage'].includes(e.name)) continue;
    if (e.isDirectory()) walk(path.join(dir, e.name), found);
    else if (/\.(ts|tsx|mjs|js)$/.test(e.name)) found.push(path.join(dir, e.name));
  }
  return found;
};

describe('the semantic search dependencies', () => {
  const adapter = JSON.parse(read('packages/adapters/embedder-onnx/package.json')) as { dependencies: Record<string, string> };

  it('are onnxruntime-node 1.31.1 and @huggingface/tokenizers 0.2.0, exactly, and the packages that would bring an LGPL component or a second runtime are absent', () => {
    expect(adapter.dependencies['onnxruntime-node']).toBe('1.31.1');
    expect(adapter.dependencies['@huggingface/tokenizers']).toBe('0.2.0');
    expect(JSON.parse(read('node_modules/onnxruntime-node/package.json')).version).toBe('1.31.1');
    expect(JSON.parse(read('node_modules/@huggingface/tokenizers/package.json')).version).toBe('0.2.0');
    expect(existsSync(path.join(root, 'node_modules/@huggingface/transformers'))).toBe(false);
    expect(existsSync(path.join(root, 'node_modules/onnxruntime-web'))).toBe(false);
  });

  it('are imported by the embedder adapter only, and by nothing in core', () => {
    const offenders = ['apps', 'packages']
      .flatMap((top) => walk(path.join(root, top)))
      .filter((file) => /onnxruntime|@huggingface/.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(root, file).split(path.sep).join('/'))
      .filter((file) => !file.startsWith('packages/adapters/embedder-onnx/') && file !== 'apps/server/test/semantic/dependencies.test.ts');
    expect(offenders).toEqual([]);
  });

  it('bring no GPU library: the install of onnxruntime-node is told to skip the CUDA download, is not a trusted script, and left nothing named for CUDA or TensorRT', () => {
    expect(read('.npmrc').split('\n')).toContain('onnxruntime-node-install-cuda=skip');
    // A package script runs only for a package the root names as trusted: with this absent a plain install cannot fetch the 284 MB of proprietary libraries.
    expect((JSON.parse(read('package.json')) as { trustedDependencies?: string[] }).trustedDependencies ?? []).not.toContain('onnxruntime-node');
    const everything = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? everything(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    const found = everything(path.join(root, 'node_modules/onnxruntime-node'));
    expect(found.filter((f) => /cuda|tensorrt|libnvinfer|libcudart/i.test(f))).toEqual([]);
  });

  it('weigh what the image holds for linux x64 (the native library and the binding) under 80 MB; the other platforms of the package are not shipped', () => {
    expect(sizeOf(path.join(root, 'node_modules/onnxruntime-node/bin/napi-v6/linux/x64')) / 1024 ** 2).toBeLessThan(80);
  });
});
