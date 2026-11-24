// Which TypeScript files a typecheck covers. A project is a tsconfig that names what it includes (`include` or `files`: the shared base config names nothing, and
// so would take in every file under its folder), reached from the root `tsconfig.json` through `references` (what `tsc -b` builds), or one of the two
// kinds `bun run typecheck` and `bun run check:infra` run on their own: `tsconfig.tests.json` (the tests of a package, every one of them) and `tsconfig.sst.json`.
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const skipDirs = new Set(['node_modules', 'dist', 'coverage', '.git', '.sst', 'out', 'test-results', '.work', '.tsbuild']);
const typescriptFile = (name) => /\.(ts|tsx|mts|cts)$/.test(name) && !/\.d\.[cm]?ts$/.test(name);

function walk(dir, visit) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) walk(full, visit);
    } else visit(full, entry.name);
  }
}

const readConfig = (file) => ts.readConfigFile(file, ts.sys.readFile).config ?? {};

/** The `tsconfig.tests.json` files of the tree: the projects that typecheck tests, each run by `tools/ci/typecheck-tests.mjs`. */
export function testProjects(root) {
  const found = [];
  walk(root, (full, name) => { if (name === 'tsconfig.tests.json') found.push(full); });
  return found.sort();
}

/** The TypeScript files (not declarations) that no project includes, as paths relative to `root`. */
export function uncoveredFiles(root) {
  const projects = new Set();
  const follow = (file) => {
    const real = path.resolve(file);
    if (projects.has(real) || !existsSync(real)) return;
    projects.add(real);
    for (const reference of readConfig(real).references ?? []) {
      const target = path.resolve(path.dirname(real), reference.path);
      follow(target.endsWith('.json') ? target : path.join(target, 'tsconfig.json'));
    }
  };
  follow(path.join(root, 'tsconfig.json'));
  follow(path.join(root, 'tsconfig.sst.json'));
  for (const file of testProjects(root)) follow(file);

  const covered = new Set();
  for (const file of projects) {
    const raw = readConfig(file);
    if (raw.include === undefined && raw.files === undefined) continue; // names nothing: would take in the whole folder
    const parsed = ts.parseJsonConfigFileContent(raw, ts.sys, path.dirname(file), undefined, file);
    for (const name of parsed.fileNames) covered.add(path.resolve(name));
  }
  const missing = [];
  walk(root, (full, name) => { if (typescriptFile(name) && !covered.has(path.resolve(full))) missing.push(path.relative(root, full).split(path.sep).join('/')); });
  return missing.sort();
}
