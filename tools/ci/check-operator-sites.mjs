// Fails on a use of the operator connection (docs/tenancy.md section 3.2) outside the modules of tools/ci/operator-sites.mjs: the type `OperatorDatabase`, the
// function `createOpsDatabase`, `operator` called, imported, exported or reached as a property (`db.operator` after `import * as db`), or a read of the setting
// `opsUrl` (`config.database.opsUrl`, `['opsUrl']`, `{ opsUrl }`): a plain database over that URL would be the operator role with `query`, past the type. The module
// that defines the handle, the settings that define the URL, composition (which hands it to `createOpsDatabase`) and test files are not call sites. Uses are found
// with the TypeScript parser, so a comment, a string or an object key called `operator` or `opsUrl` does not count.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { OPERATOR_SITES } from './operator-sites.mjs';

const DEFINED_IN = 'packages/adapters/db-kysely/src/index.ts';
const OPS_URL_DEFINERS = new Set(['packages/adapters/config-env/src/schema.ts', 'packages/core/src/ports/config.ts', 'apps/server/src/composition.ts']);
const NAMES = new Set(['OperatorDatabase', 'createOpsDatabase']);
const skipDirs = new Set(['node_modules', 'dist', 'coverage', '.git', '.sst', 'out', 'test-results']);
const testFile = (rel) => /(^|\/)(test|test-e2e)\//.test(rel) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel);
const sourceFile = (name) => /\.[cm]?[jt]sx?$/.test(name) && !name.endsWith('.d.ts');
const kindFor = (file) => (/\.[cm]?tsx$/.test(file) ? ts.ScriptKind.TSX : /\.[cm]?jsx?$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS);

/** Whether `node` names `name` as a property read: `x.name`, `x['name']`, or `{ name }` / `{ name: y }` in a destructuring. */
function readsProperty(node, name) {
  const p = node.parent;
  if (ts.isIdentifier(node) && node.text === name) return (ts.isPropertyAccessExpression(p) && p.name === node) || (ts.isBindingElement(p) && ts.isObjectBindingPattern(p.parent) && (p.propertyName ?? p.name) === node);
  return ts.isStringLiteralLike(node) && node.text === name && ts.isElementAccessExpression(p) && p.argumentExpression === node;
}

/** `rel:line name` for each use in one source file. */
function usesIn(text, rel) {
  const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, kindFor(rel));
  const found = [];
  const visit = (node) => {
    const p = node.parent;
    const operator = ts.isIdentifier(node) && node.text === 'operator' && ((ts.isCallExpression(p) && p.expression === node) || ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || readsProperty(node, 'operator'));
    const named = (ts.isIdentifier(node) && NAMES.has(node.text)) || operator || (!OPS_URL_DEFINERS.has(rel) && readsProperty(node, 'opsUrl'));
    if (named) found.push(`${rel}:${String(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1)} ${node.text}`);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Every use of the operator handle under `root` outside the registered `sites`, sorted. An entry without a module or a reason is refused. */
export function findOperatorUses(root, sites) {
  for (const site of sites) if (!site.module || !site.reason) throw new Error('each entry of tools/ci/operator-sites.mjs names a module and the reason it crosses tenants');
  const allowed = new Set([DEFINED_IN, ...sites.map((s) => s.module)]);
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (entry.isDirectory()) { if (!skipDirs.has(entry.name)) walk(full); } else if (sourceFile(entry.name) && !testFile(rel) && !allowed.has(rel)) found.push(...usesIn(readFileSync(full, 'utf8'), rel));
    }
  };
  walk(root);
  return found.sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const found = findOperatorUses(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), OPERATOR_SITES);
  if (found.length > 0) {
    process.stderr.write(`${found.join('\n')}\n${String(found.length)} use(s) of the operator connection outside tools/ci/operator-sites.mjs: add the module there with its reason, or use scoped(db, tenant)\n`);
    process.exit(1);
  }
}
