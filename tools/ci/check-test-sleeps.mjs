// Fails on any fixed sleep of more than 250 ms in a test file (M3-T01c, decision 128): `sleep(n)`, `delay(n)`, `setTimeout(..., n)` and
// `await new Promise((r) => setTimeout(r, n))`. A delay that is not a numeric literal (a name or an expression) cannot be checked, so
// it needs an allow-list entry with a reason; so does every `setInterval` in test code (the allowed ones are listed on each run). Wait for a condition instead (`vi.waitFor`, the shared `eventually`).
// A line is exempt only through an entry of tools/ci/test-sleep-allow.json that names the file, the exact line text and a reason.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LIMIT_MS = 250;
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const skipDirs = new Set(['node_modules', 'dist', 'coverage', '.git', 'out', 'test-results']);
const testFile = (rel) => /(^|\/)(test|test-e2e)\//.test(rel) || /\.test\.[cm]?[jt]s$/.test(rel);
const sourceFile = (name) => /\.[cm]?[jt]s$/.test(name);
const CALL = /(?<!function\s)\b(?:sleep|delay|setTimeout)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;

/** The literal milliseconds of a sleep-like call argument list, or undefined when the delay is not a literal. */
function literalMs(call, args) {
  const parts = args.split(',').map((p) => p.trim());
  const delay = call === 'setTimeout' ? parts[parts.length - 1] : parts[0];
  const match = /^(\d[\d_]*(?:\.\d+)?)(?:\s*\*\s*(\d[\d_]*(?:\.\d+)?))?$/.exec(delay ?? '');
  if (!match) return undefined;
  return Number(match[1].replaceAll('_', '')) * (match[2] ? Number(match[2].replaceAll('_', '')) : 1);
}

/** Violations in one file's text: [{ file, line, text, ms }]. */
export function findSleeps(file, text) {
  const out = [];
  text.split('\n').forEach((raw, index) => {
    const line = raw.replace(/(^|[^:])\/\/.*$/, '$1');
    // A setInterval call usually spans lines, so only its opening is matched.
    if (/(?<!function\s)\bsetInterval\s*\(/.test(line)) out.push({ file, line: index + 1, text: raw.trim(), ms: undefined, kind: 'interval' });
    for (const m of line.matchAll(CALL)) {
      const call = m[0].slice(0, m[0].indexOf('(')).trim();
      const text = raw.trim();
      const ms = literalMs(call, m[1]);
      if (ms === undefined) out.push({ file, line: index + 1, text, ms, kind: 'non-literal' });
      else if (ms > LIMIT_MS) out.push({ file, line: index + 1, text, ms, kind: 'literal-over-limit' });
    }
  });
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const allow = JSON.parse(readFileSync(path.join(here, 'test-sleep-allow.json'), 'utf8'));
  const bad = check(root, ['apps', 'packages'], allow);
  for (const v of bad) {
    const why = v.kind === 'interval' ? 'setInterval needs an allow-list entry' : v.kind === 'non-literal' ? 'delay is not a numeric literal' : `fixed sleep of ${String(v.ms)} ms (limit ${String(LIMIT_MS)})`;
    console.error(`${v.file}:${String(v.line)}: ${why}: ${v.text}`);
  }
  if (bad.length > 0) {
    console.error(`${String(bad.length)} test timer(s) to fix: wait for a condition (vi.waitFor, eventually), or add a justified entry (file, exact line, reason) to tools/ci/test-sleep-allow.json.`);
    process.exit(1);
  }
  const intervals = check(root, ['apps', 'packages'], allow, true).filter((v) => v.kind === 'interval');
  for (const v of intervals) console.log(`setInterval in tests: ${v.file}:${String(v.line)}: ${allow.find((a) => a.file === v.file && a.line.trim() === v.text)?.reason ?? ''}`);
}
