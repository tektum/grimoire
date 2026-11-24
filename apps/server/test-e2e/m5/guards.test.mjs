import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The rules of the milestone 5 end-to-end test, checked on its own source before the stack is used (`make test-m5` runs this first): requests to the application go through
// the generated client, only the support file talks to the store by hand, every scenario declares a timeout with its reason, nothing sleeps, and the run list is the
// set of scenario files (the runner exits 1 when they differ).
const here = path.dirname(fileURLToPath(import.meta.url));
const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : /\.(ts|mjs)$/.test(e.name) ? [path.join(dir, e.name)] : []));
const all = files(here).filter((f) => !f.endsWith('guards.test.mjs') && !f.includes(`${path.sep}browser${path.sep}`));
const scenarioDir = path.join(here, 'scenarios');
const scenarios = all.filter((f) => f.startsWith(scenarioDir));
const text = (f) => readFileSync(f, 'utf8');

test('no scenario sends a request by hand: the generated client is the way to the application, and the store is reached through the support file only', () => {
  // Written in pieces so that this file does not contain what it forbids.
  const hand = new RegExp(`${'fe'}${'tch\\('}`);
  const forbidden = [new RegExp(`${'app'}\\.${'request\\('}`), new RegExp('super' + 'test')];
  const found = all.flatMap((f) => [
    ...forbidden.filter((re) => re.test(text(f))).map((re) => `${path.relative(here, f)}: ${String(re)}`),
    ...(hand.test(text(f)) && path.basename(f) !== 'support.ts' ? [`${path.relative(here, f)}: a request by hand outside support.ts`] : []),
  ]);
  assert.deepEqual(found, []);
  assert.doesNotMatch(text(path.join(here, 'support.ts')), /fetch\(`?\$\{BASE\}|fetch\(BASE/, 'support.ts sends nothing to the application by hand');
});

test('every scenario declares a timeout with a reason on the same line, and the runner lists exactly the scenario files', () => {
  assert.ok(scenarios.length >= 8, 'the scenarios are there');
  for (const f of scenarios) {
    const line = text(f).split('\n').find((l) => l.startsWith('await scenario('));
    assert.ok(line !== undefined, `${path.basename(f)} calls scenario(...)`);
    assert.match(line, /^await scenario\('[a-z-]+', \d[\d_]*, async \(t\) => \{ \/\/ timeout: \S.+/, `${path.basename(f)} states its timeout and why`);
  }
  const declared = /SCENARIOS = \[([^\]]*)\]/.exec(text(path.join(here, 'list.ts')))?.[1] ?? '';
  assert.deepEqual([...declared.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]).sort(), scenarios.map((f) => path.basename(f, '.ts')).sort());
});

test('nothing sleeps: waits are conditions (`eventually`), not timers', () => {
  const found = all.flatMap((f) => (/\b(sleep|setTimeout)\(/.test(text(f)) ? [path.relative(here, f)] : []));
  assert.deepEqual(found, []);
});

// The runner, started with `--list` against a copy of the scenario directory: it names every scenario and exits 0; with one scenario file removed, or one added, it names the
// difference and exits 1, so a scenario cannot drop out of the run unnoticed.
test('the runner names every scenario and exits 1 when a scenario is removed from the run or an unlisted one is added', () => {
  const work = path.join(here, '../../../../test-results/m5-guard');
  rmSync(work, { recursive: true, force: true });
  const runner = (dir) => spawnSync('node', [path.join(here, 'run.ts'), '--list'], { env: { ...process.env, GRIMOIRE_M5_SCENARIOS_DIR: dir }, encoding: 'utf8' });
  const names = scenarios.map((f) => path.basename(f, '.ts'));
  try {
    mkdirSync(work, { recursive: true });
    const whole = path.join(work, 'whole');
    cpSync(scenarioDir, whole, { recursive: true });
    const ok = runner(whole);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    for (const name of names) assert.match(ok.stdout, new RegExp(`scenarios: .*\\b${name}\\b`), `${name} is named`);

    const removed = path.join(work, 'removed');
    cpSync(scenarioDir, removed, { recursive: true });
    rmSync(path.join(removed, `${names[0]}.ts`));
    const lacking = runner(removed);
    assert.equal(lacking.status, 1);
    assert.match(lacking.stdout, new RegExp(`FAIL run list: ${names[0]} is in the run list and has no file`));

    const added = path.join(work, 'added');
    cpSync(scenarioDir, added, { recursive: true });
    writeFileSync(path.join(added, 'extra.ts'), '');
    const extra = runner(added);
    assert.equal(extra.status, 1);
    assert.match(extra.stdout, /FAIL run list: extra is a scenario file that is not in the run list/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
