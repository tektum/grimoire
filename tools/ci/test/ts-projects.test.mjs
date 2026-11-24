import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { testProjects, uncoveredFiles } from '../ts-projects.mjs';

/** A scratch tree: `files` maps a path to its content. */
function tree(files, run) {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'grimoire-ts-projects-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(join(root, name, '..'), { recursive: true });
      writeFileSync(join(root, name), content);
    }
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const json = (value) => JSON.stringify(value);
const base = json({ compilerOptions: { strict: true } }); // names no files: it must never count as covering the folder

test('a file that no project includes is reported, one that a project reached from the root includes is not', () => {
  const found = tree({
    'tsconfig.base.json': base,
    'tsconfig.json': json({ files: [], references: [{ path: './pkg' }] }),
    'pkg/tsconfig.json': json({ extends: '../tsconfig.base.json', include: ['src'] }),
    'pkg/src/a.ts': 'export {};',
    'pkg/test/b.test.ts': 'export {};',
    'loose.ts': 'export {};',
  }, uncoveredFiles);
  assert.deepEqual(found, ['loose.ts', 'pkg/test/b.test.ts']);
});

test('a tsconfig.tests.json covers the tests of its package even when no root reference names it; declarations and build output are not files to cover', () => {
  const found = tree({
    'tsconfig.json': json({ files: [] }),
    'pkg/tsconfig.tests.json': json({ include: ['src', 'test'] }),
    'pkg/src/a.ts': 'export {};',
    'pkg/test/b.int.test.ts': 'export {};',
    'pkg/test/types.d.ts': 'export {};',
    'pkg/dist/c.ts': 'export {};',
    'node_modules/x/d.ts': 'export {};',
  }, uncoveredFiles);
  assert.deepEqual(found, []);
});

test('a config that names no include or files does not count as covering everything under it, and a missing reference is ignored', () => {
  const found = tree({
    'tsconfig.json': json({ files: [], references: [{ path: './gone' }, { path: './open' }] }),
    'open/tsconfig.json': json({ compilerOptions: {} }),
    'open/a.ts': 'export {};',
  }, uncoveredFiles);
  assert.deepEqual(found, ['open/a.ts']);
});

test('the tests projects are every tsconfig.tests.json, found at any depth', () => {
  const found = tree({ 'a/tsconfig.tests.json': '{}', 'b/c/tsconfig.tests.json': '{}', 'b/tsconfig.json': '{}', 'node_modules/z/tsconfig.tests.json': '{}' }, (root) => testProjects(root).map((p) => p.slice(root.length + 1)));
  assert.deepEqual(found, ['a/tsconfig.tests.json', 'b/c/tsconfig.tests.json']);
});

test('on this repository every TypeScript file is in a typecheck project, and the typecheck script runs the tests projects', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  assert.deepEqual(uncoveredFiles(root), []);
  const scripts = JSON.parse(readFileSync(`${root}package.json`, 'utf8')).scripts;
  assert.match(scripts.typecheck, /node tools\/ci\/typecheck-tests\.mjs/);
  assert.match(scripts.lint, /node tools\/ci\/check-ts-projects\.mjs/);
});
