// Fails on any fixed sleep of more than 250 ms in a test file (M3-T01c, decision 128): `sleep(n)`, `delay(n)`, `setTimeout(..., n)` and
// `await new Promise((r) => setTimeout(r, n))`. A delay that is not a numeric literal (a name or an expression) cannot be checked, so
// it needs an allow-list entry with a reason; so does every `setInterval` in test code (the allowed ones are listed on each run). Wait for a condition instead (`vi.waitFor`, the shared `eventually`).
// A line is exempt only through an entry of tools/ci/test-sleep-allow.json that names the file, the exact line text and a reason.
// Calls are found with the TypeScript parser (already a dependency), so nesting, line breaks and comments cannot hide a timer. This is a small script and not an ESLint rule because
// the allow-list is checked across the whole tree (an entry for a missing file or for a line that is no longer a sleep is an error), which a per-file rule cannot do.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

export const LIMIT_MS = 250;
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const skipDirs = new Set(['node_modules', 'dist', 'coverage', '.git', 'out', 'test-results']);
const testFile = (rel) => /(^|\/)(test|test-e2e)\//.test(rel) || /\.test\.[cm]?[jt]sx?$/.test(rel);
const sourceFile = (name) => /\.[cm]?[jt]sx?$/.test(name);
const TIMER_CALLS = new Set(['sleep', 'delay', 'setTimeout']);
const kindFor = (file) => (/\.[cm]?tsx$/.test(file) ? ts.ScriptKind.TSX : /\.[cm]?jsx?$/.test(file) ? (file.endsWith('x') ? ts.ScriptKind.JSX : ts.ScriptKind.JS) : ts.ScriptKind.TS);

/** The called name of `name(...)` or `object.name(...)`, or undefined. */
function calleeName(node) {
  const e = node.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return undefined;
}

/** The milliseconds of a numeric literal (or a product of literals), or undefined when the delay is not a literal. */
function literalMs(node) {
  if (node === undefined) return undefined;
  if (ts.isParenthesizedExpression(node)) return literalMs(node.expression);
  if (ts.isNumericLiteral(node)) return Number(node.text.replaceAll('_', ''));
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AsteriskToken) {
    const l = literalMs(node.left);
    const r = literalMs(node.right);
    return l === undefined || r === undefined ? undefined : l * r;
  }
  return undefined;
}

/** Violations in one file's text: [{ file, line, text, ms, kind }]; `line` is where the call starts. */
export function findSleeps(file, text) {
  const out = [];
  if (!/sleep|delay|setTimeout|setInterval/.test(text)) return out;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kindFor(file));
  const lines = text.split('\n');
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
      const at = { file, line: line + 1, text: (lines[line] ?? '').trim() };
      if (name === 'setInterval') out.push({ ...at, ms: undefined, kind: 'interval' });
      else if (name !== undefined && TIMER_CALLS.has(name)) {
        const ms = literalMs(node.arguments[name === 'setTimeout' ? 1 : 0]);
        if (ms === undefined) out.push({ ...at, ms, kind: 'non-literal' });
        else if (ms > LIMIT_MS) out.push({ ...at, ms, kind: 'literal-over-limit' });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/** Drops the violations covered by a complete allow-list entry (file, line text, non-empty reason). */
export function applyAllow(violations, allow) {
  return violations.filter((v) => !allow.some((a) => a.file === v.file && typeof a.line === 'string' && a.line.trim() === v.text && typeof a.reason === 'string' && a.reason.trim() !== ''));
}

function walk(dir, rel = '') {
  const files = [];
  for (const entry of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const next = rel === '' ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) { if (!skipDirs.has(entry.name)) files.push(...walk(dir, next)); } else if (sourceFile(entry.name) && testFile(next)) files.push(next);
  }
  return files;
}

/** Scans `scanRoots` (relative to `base`) and returns the violations the allow-list does not cover. */
export function check(base, scanRoots, allow, all = false) {
  const violations = [];
  for (const scanRoot of scanRoots) {
    if (!existsSync(path.join(base, scanRoot))) continue; // a scan root that does not exist yet has no tests to check
    for (const rel of walk(path.join(base, scanRoot)).map((f) => `${scanRoot}/${f}`)) violations.push(...findSleeps(rel, readFileSync(path.join(base, rel), 'utf8')));
  }
  return all ? violations : applyAllow(violations, allow);
}

/** Allow-list entries that cover nothing: the file is missing, or has no timer call on that exact line (every kind counts). */
export function staleEntries(base, scanRoots, allow) {
  const all = check(base, scanRoots, [], true);
  return allow.filter((a) => !all.some((v) => v.file === a.file && typeof a.line === 'string' && v.text === a.line.trim()));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const allow = JSON.parse(readFileSync(path.join(here, 'test-sleep-allow.json'), 'utf8'));
  const bad = check(root, ['apps', 'packages'], allow);
  for (const v of bad) {
    const why = v.kind === 'interval' ? 'setInterval needs an allow-list entry' : v.kind === 'non-literal' ? 'delay is not a numeric literal' : `fixed sleep of ${String(v.ms)} ms (limit ${String(LIMIT_MS)})`;
    console.error(`${v.file}:${String(v.line)}: ${why}: ${v.text}`);
  }
  const stale = staleEntries(root, ['apps', 'packages'], allow);
  for (const a of stale) console.error(`stale allow-list entry (file missing, or no timer call on that line any more): ${String(a.file)}: ${String(a.line)}`);
  if (bad.length + stale.length > 0) {
    console.error(`${String(bad.length)} test timer(s) to fix and ${String(stale.length)} stale allow-list entr(y/ies): wait for a condition (vi.waitFor, eventually), or add a justified entry (file, exact line, reason) to tools/ci/test-sleep-allow.json.`);
    process.exit(1);
  }
  const intervals = check(root, ['apps', 'packages'], allow, true).filter((v) => v.kind === 'interval');
  for (const v of intervals) console.log(`setInterval in tests: ${v.file}:${String(v.line)}: ${allow.find((a) => a.file === v.file && typeof a.line === 'string' && a.line.trim() === v.text)?.reason ?? ''}`);
}
