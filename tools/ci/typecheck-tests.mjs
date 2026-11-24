// Typechecks the tests: runs `tsc -p` on every `tsconfig.tests.json` (the source and the tests of one package, each test file, unit, integration and end-to-end alike, with the
// settings of its package). Run after `bun run build`, since packages reach each other through their built declarations. Every project runs even when one fails.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testProjects } from './ts-projects.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tsc = path.join(root, 'node_modules/typescript/bin/tsc');
let failed = 0;
for (const project of testProjects(root)) {
  const rel = path.relative(root, project);
  const run = spawnSync(process.execPath, [tsc, '-p', project], { cwd: root, encoding: 'utf8' });
  if (run.status === 0) continue;
  failed += 1;
  process.stderr.write(`${rel}\n${run.stdout}${run.stderr}\n`);
}
if (failed > 0) { process.stderr.write(`${String(failed)} test project(s) do not typecheck.\n`); process.exit(1); }
