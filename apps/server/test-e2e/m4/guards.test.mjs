import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The rules of the milestone 4 end-to-end test, checked on its own source before the stack is used (`make test-m4` runs this first):
// every request goes through the generated client, every scenario declares a timeout with its reason, and nothing sleeps.
const here = path.dirname(fileURLToPath(import.meta.url));
const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : /\.(ts|mjs)$/.test(e.name) ? [path.join(dir, e.name)] : []));
const all = files(here).filter((f) => !f.endsWith('guards.test.mjs'));
const scenarios = all.filter((f) => f.includes(`${path.sep}scenarios${path.sep}`));
const text = (f) => readFileSync(f, 'utf8');

test('no scenario or helper sends a request by hand: the generated client is the only way in', () => {
  // Written in pieces so that this file does not contain what it forbids.
  const forbidden = [new RegExp(`${'fe'}${'tch\\('}`), new RegExp(`${'app'}\\.${'request\\('}`), new RegExp('super' + 'test')];
  const found = all.flatMap((f) => forbidden.filter((re) => re.test(text(f))).map((re) => `${path.relative(here, f)}: ${String(re)}`));
  assert.deepEqual(found, []);
});

test('every scenario declares a timeout with a reason on the same line, and the runner lists exactly the scenario files', () => {
  for (const f of scenarios) {
    const line = text(f).split('\n').find((l) => l.startsWith('await scenario('));
    assert.ok(line !== undefined, `${path.basename(f)} calls scenario(...)`);
    assert.match(line, /^await scenario\('[a-z-]+', \d[\d_]*, async \(t\) => \{ \/\/ timeout: \S.+/, `${path.basename(f)} states its timeout and why`);
  }
  const listed = [...text(path.join(here, 'run.ts')).matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
  const names = scenarios.map((f) => path.basename(f, '.ts')).sort();
  for (const name of names) assert.ok(listed.includes(name), `run.ts lists ${name}`);
  const declared = /SCENARIOS = \[([^\]]*)\]/.exec(text(path.join(here, 'run.ts')))?.[1] ?? '';
  assert.deepEqual([...declared.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]).sort(), names);
});

test('nothing sleeps: waits are conditions (`eventually`), not timers', () => {
  const found = all.flatMap((f) => (/\b(sleep|setTimeout)\(/.test(text(f)) ? [path.relative(here, f)] : []));
  assert.deepEqual(found, []);
});
