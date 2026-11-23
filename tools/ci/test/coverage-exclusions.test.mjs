import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

// Coverage exclusions need a written reason on the same line (a number is never reached by excluding code): every
// `v8 ignore` comment in a source file, and every entry of the coverage `exclude` list in vitest.config.js.
const root = path.resolve(import.meta.dirname, '../../..');
const skip = new Set(['node_modules', 'dist', 'coverage', '.git', 'reference']);

function sources(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (!skip.has(entry.name)) sources(full, out); } else if (entry.name.endsWith('.ts') && full.split(path.sep).includes('src')) out.push(full);
  }
  return out;
}

/** Lines that carry an ignore directive without ` -- reason`. */
export function ignoresWithoutReason(text) {
  return text.split('\n').flatMap((line, i) => (/(v8|istanbul|c8) ignore/.test(line) && !/ignore[^\n]*--\s*[^\s*]/.test(line) ? [i + 1] : []));
}

/** Entries of the coverage `exclude` array of a vitest config without a trailing `// reason`. */
export function excludesWithoutReason(text) {
  const start = text.indexOf('exclude: [', text.indexOf('coverage:'));
  const end = text.indexOf('],', start);
  return text.slice(start, end).split('\n').slice(1).filter((l) => /"[^"]+"/.test(l) && !l.includes('...') && !/\/\/\s*\S/.test(l)).map((l) => l.trim());
}

/** Entries of the `integrationCovered` array of the unit config without a trailing `// reason`. */
export function integrationCoveredWithoutReason(text) {
  const start = text.indexOf('export const integrationCovered = [');
  const end = text.indexOf('];', start);
  return text.slice(start, end).split('\n').slice(1).filter((l) => /"[^"]+"/.test(l) && !/\/\/\s*\S/.test(l)).map((l) => l.trim());
}

test('a v8 ignore needs a reason after -- on the same line', () => {
  assert.deepEqual(ignoresWithoutReason('/* v8 ignore next -- unreachable: exhaustive switch */'), []);
  assert.deepEqual(ignoresWithoutReason('x();\n/* v8 ignore next */'), [2]);
  assert.deepEqual(ignoresWithoutReason('/* v8 ignore next -- */'), [1]);
});

test('a coverage exclusion needs a reason after // on the same line', () => {
  const ok = 'coverage: {\n exclude: [\n  ...exclude,\n  "a/**", // why\n ],\n}';
  assert.deepEqual(excludesWithoutReason(ok), []);
  assert.deepEqual(excludesWithoutReason(ok.replace(' // why', '')), ['"a/**",']);
});

test('a file left out of the unit run because only integration tests cover it needs its reason too', () => {
  const ok = 'export const integrationCovered = [\n  "a.ts", // why\n];';
  assert.deepEqual(integrationCoveredWithoutReason(ok), []);
  assert.deepEqual(integrationCoveredWithoutReason(ok.replace(' // why', '')), ['"a.ts",']);
  assert.deepEqual(integrationCoveredWithoutReason('nothing here'), []);
});

test('every ignore directive in the sources and every coverage exclusion of this repository has its reason', () => {
  const offenders = [];
  for (const top of ['apps', 'packages']) for (const file of sources(path.join(root, top))) {
    for (const line of ignoresWithoutReason(readFileSync(file, 'utf8'))) offenders.push(`${path.relative(root, file)}:${String(line)}`);
  }
  assert.deepEqual(offenders, []);
  const config = readFileSync(path.join(root, 'vitest.config.js'), 'utf8');
  assert.deepEqual(excludesWithoutReason(config), []);
  assert.deepEqual(integrationCoveredWithoutReason(config), []);
});
