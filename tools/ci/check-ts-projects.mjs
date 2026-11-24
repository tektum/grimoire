// Fails when a TypeScript file is in no typecheck project: a file nothing typechecks can hold a type error (a duplicate import, a wrong argument) that only shows when it runs,
// and the integration and end-to-end tests run in CI alone. Add the folder to the `tsconfig.tests.json` of its package (or a project reachable from the root `tsconfig.json`).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { uncoveredFiles } from './ts-projects.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const missing = uncoveredFiles(root);
if (missing.length > 0) {
  process.stderr.write(`${missing.join('\n')}\n${String(missing.length)} TypeScript file(s) in no typecheck project: include them in the tsconfig.tests.json of their package, or in a project of the root tsconfig.json.\n`);
  process.exit(1);
}
