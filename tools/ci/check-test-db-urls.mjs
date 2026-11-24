// Fails on a credentialed Postgres URL written as a literal in a test file (`postgresql://user:password@host/db`, in a string or a template): tests take theirs from the
// shared fixtures (`adminUrl`, `appUrl`, `migratorUrl` of @tektum/grimoire-test-support/database for the development stack, `placeholderDatabaseUrl` and `databaseUrl` of
// @tektum/grimoire-core/testing/database-url for a URL that is only parsed), so that a password never sits in a test file, whatever its value. A URL whose password is an
// interpolated value (`${password}`) is not a literal and passes; so does one without a password. The fixtures themselves are not test files. Calls are found with the TypeScript
// parser, so comments cannot trip it.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const skipDirs = new Set(['node_modules', 'dist', 'coverage', '.git', '.sst', 'out', 'test-results']);
const testFile = (rel) => /(^|\/)(test|test-e2e)\//.test(rel) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel);
const sourceFile = (name) => /\.[cm]?[jt]sx?$/.test(name);
const HOLE = '\u0000'; // stands for an interpolation in a template
// The password must hold at least one literal character (a password that is wholly interpolated is not a literal).
const CREDENTIALED = new RegExp(`postgres(?:ql)?://[^/\\s@:${HOLE}]*:(?=[^/\\s@]*[^/\\s@${HOLE}])[^/\\s@]+@`);
const kindFor = (file) => (/\.[cm]?tsx$/.test(file) ? ts.ScriptKind.TSX : /\.[cm]?jsx?$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS);

/** The lines of `text` (a source file called `file`) that hold a string or template literal with a credentialed Postgres URL whose password is literal. */
export function findCredentialedUrls(text, file = 'file.ts') {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kindFor(file));
  const found = [];
  const check = (node, value) => {
    if (CREDENTIALED.test(value)) found.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
  };
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) check(node, node.text);
    else if (ts.isTemplateExpression(node)) check(node, node.head.text + node.templateSpans.map((span) => HOLE + span.literal.text).join(''));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function walk(dir, found) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) walk(full, found);
    } else if (sourceFile(entry.name)) {
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (testFile(rel)) for (const line of findCredentialedUrls(readFileSync(full, 'utf8'), rel)) found.push(`${rel}:${String(line)}`);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const found = [];
  walk(root, found);
  if (found.length > 0) {
    process.stderr.write(`${found.join('\n')}\n${String(found.length)} credentialed Postgres URL literal(s) in test files: take the URL from the shared fixtures (adminUrl, appUrl, migratorUrl, placeholderDatabaseUrl, databaseUrl).\n`);
    process.exit(1);
  }
}
