import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { repoRoot } from './paths.js';

type Project = { references?: { path: string }[] };

// Derived from the directory: an adapter added later is covered without anyone remembering to extend a list.
const adapters = readdirSync(path.join(repoRoot, 'packages/adapters'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();

function adaptersReferencedBy(projectFile: string): string[] {
  const project = JSON.parse(readFileSync(path.resolve(repoRoot, projectFile), 'utf8')) as Project;
  return (project.references ?? [])
    .map((reference) => path.posix.normalize(path.posix.join(path.posix.dirname(path.relative(repoRoot, path.resolve(repoRoot, projectFile))), reference.path)))
    .filter((reference) => reference.startsWith('packages/adapters/'))
    .map((reference) => reference.slice('packages/adapters/'.length));
}

it('references every adapter from the root and server build projects', () => {
  expect(adaptersReferencedBy('tsconfig.json')).toEqual(expect.arrayContaining(adapters));
  expect(adaptersReferencedBy('apps/server/tsconfig.json')).toEqual(expect.arrayContaining(adapters));
});
