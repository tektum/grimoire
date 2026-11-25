// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// M7-T00 (contracts section 1): the dependencies of the import and the pins. The tests read the files the package manager wrote, from the repository root.
// The repository root, from this file (the tests may be started from any folder).
const root = resolve(import.meta.dirname, '../../../..');
const lock = readFileSync(resolve(root, 'bun.lock'), 'utf8');
const server = JSON.parse(readFileSync(resolve(root, 'apps/server/package.json'), 'utf8')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
/** The versions of a package that the lockfile resolves, each once. */
const installed = (name: string): string[] => [...new Set([...lock.matchAll(new RegExp(`"${name.replace('/', '\\/')}@(\\d+\\.\\d+\\.\\d+[^"]*)"`, 'g'))].map((m) => m[1] as string))];

describe('the import dependencies', () => {
  it.each([['yauzl', '3.4.0'], ['csv-parse', '7.0.3'], ['request-filtering-agent', '3.3.0']])('pins %s at exactly %s, once', (name, version) => {
    expect(server.dependencies[name]).toBe(version);
    expect(installed(name)).toEqual([version]);
  });

  it('has the types of yauzl as a development dependency, once, at the version the manifest declares', () => {
    expect(server.devDependencies['@types/yauzl']).toMatch(/^\d+\.\d+\.\d+$/);
    expect(installed('@types/yauzl')).toEqual([server.devDependencies['@types/yauzl']]);
  });

  it.each(['unified', 'remark-parse', 'remark-gfm', 'unist-util-visit', 'remark-stringify'])('has %s as a direct dependency of the server, and one copy only', (name) => {
    expect(server.dependencies[name]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(installed(name)).toEqual([server.dependencies[name]]);
  });

  it('keeps the parsing libraries out of the core', () => {
    const core = JSON.parse(readFileSync(resolve(root, 'packages/core/package.json'), 'utf8')) as { dependencies?: Record<string, string> };
    for (const name of ['yauzl', 'csv-parse', 'remark-parse', 'unified']) expect(core.dependencies?.[name]).toBeUndefined();
  });
});
