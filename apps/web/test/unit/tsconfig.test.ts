// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const web = path.resolve(import.meta.dirname, '../..');
// tsconfig files are JSON with no comments here, so JSON.parse reads them.
const tsconfig = JSON.parse(readFileSync(path.join(web, 'tsconfig.json'), 'utf8')) as { compilerOptions: Record<string, unknown>; include: string[]; references: { path: string }[] };
const options = tsconfig.compilerOptions;

describe('apps/web/tsconfig.json', () => {
  it('writes its type-check output outside dist, because the Vite build empties dist', () => {
    for (const key of ['outDir', 'tsBuildInfoFile'] as const) {
      const where = path.normalize(path.join(web, String(options[key])));
      expect(path.relative(path.join(web, 'dist'), where).startsWith('..')).toBe(true);
    }
    expect(options['emitDeclarationOnly']).toBe(true);
  });

  it('is a browser project: DOM libraries, the automatic JSX runtime, bundler resolution and the Vite types, not the Node types', () => {
    expect(options['lib']).toEqual(['ES2023', 'DOM', 'DOM.Iterable']);
    expect(options['jsx']).toBe('react-jsx');
    expect(options['moduleResolution']).toBe('Bundler');
    expect(options['types']).toEqual(['vite/client']);
  });

  it('keeps the strictness of the base configuration', () => {
    const base = JSON.parse(readFileSync(path.join(web, '../../tsconfig.base.json'), 'utf8')) as { compilerOptions: Record<string, unknown> };
    for (const key of ['strict', 'noUncheckedIndexedAccess', 'exactOptionalPropertyTypes', 'verbatimModuleSyntax']) expect([key, options[key] ?? base.compilerOptions[key]]).toEqual([key, true]);
  });

  it('is built after the packages it uses, from the root build', () => {
    expect(tsconfig.references.map((r) => r.path)).toEqual(['../../packages/core', '../../packages/api-client']);
    const rootConfig = JSON.parse(readFileSync(path.join(web, '../../tsconfig.json'), 'utf8')) as { references: { path: string }[] };
    expect(rootConfig.references.map((r) => r.path)).toContain('./apps/web');
  });

  it('keeps the type-check output out of version control', () => {
    expect(readFileSync(path.join(web, '../../.gitignore'), 'utf8').split('\n')).toContain('.tsbuild/');
  });
});
