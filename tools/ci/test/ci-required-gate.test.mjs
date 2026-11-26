import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The merge gate (`CI Required`): the script of its one step is run here, as GitHub runs it, with the `needs` it would be given. A failed or cancelled job always fails it; a skipped job passes only
// where the skip is the one the workflow means: a documentation-only change skips every code job, and the two jobs with a path filter (Semantic models, Search latency) are skipped when their filter says so.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const ci = readFileSync(new URL('.github/workflows/ci.yml', `file://${root}`), 'utf8');
const gate = ci.match(/\n {2}ci-required:\n[\s\S]*$/)?.[0] ?? '';
const script = gate.match(/run: \|\n([\s\S]*?)(?=\n {6}- |\n\S|$)/)?.[1]?.replace(/^ {10}/gm, '') ?? '';
const NEEDED = ['changes', 'checks', 'unit', 'integration', 'coverage', 'image', 'e2e-m1-m3', 'e2e-m4', 'e2e-m5', 'e2e-web', 'e2e-web-browsers', 'search-latency', 'semantic-models'];

/** The gate's answer for a set of results: `code`, `semantic` and `search` are what the `changes` job reported; `over` replaces the result of the jobs it names. */
function run({ code = 'true', semantic = 'true', search = 'false', over = {} } = {}) {
  const needs = Object.fromEntries(NEEDED.map((name) => [name, { result: 'success', outputs: {} }]));
  needs.changes.outputs = { code, semantic, search };
  for (const [name, result] of Object.entries(over)) needs[name].result = result;
  const r = spawnSync('bash', ['-c', script], { env: { ...process.env, NEEDS_JSON: JSON.stringify(needs) }, encoding: 'utf8' });
  return { status: r.status, out: r.stdout + r.stderr };
}

test('the script of the gate is found', () => {
  assert.match(script, /Verify|NEEDS_JSON/);
  assert.match(script, /CI gate/);
});

test('the gate waits for the browser jobs, Semantic models and Search latency as well as the rest', () => {
  const needs = gate.split('needs:\n')[1]?.split('steps:')[0] ?? '';
  for (const name of NEEDED) assert.ok(needs.includes(`- ${name}\n`), `${name} is in the needs of the gate`);
});

test('passes when every job succeeded', () => {
  assert.equal(run().status, 0);
});

test('a failed or cancelled job fails it, a browser job and a path-filtered job included', () => {
  for (const name of ['unit', 'e2e-web', 'e2e-web-browsers', 'semantic-models', 'search-latency']) {
    for (const result of ['failure', 'cancelled']) assert.equal(run({ over: { [name]: result } }).status, 1, `${name} ${result}`);
  }
  assert.equal(run({ search: 'false', over: { 'search-latency': 'failure' } }).status, 1, 'a job that ran and failed fails the gate whatever its filter said');
});

test('a path-filtered job that is skipped because its filter says so passes; one that should have run and did not fails', () => {
  assert.equal(run({ search: 'false', over: { 'search-latency': 'skipped' } }).status, 0);
  assert.equal(run({ semantic: 'false', over: { 'semantic-models': 'skipped' } }).status, 0);
  assert.equal(run({ search: 'true', over: { 'search-latency': 'skipped' } }).status, 1);
  assert.equal(run({ semantic: 'true', over: { 'semantic-models': 'skipped' } }).status, 1);
});

test('a job without a filter that is skipped fails the gate for a code change, the browser jobs included', () => {
  for (const name of ['unit', 'e2e-web', 'e2e-web-browsers', 'e2e-m1-m3']) assert.equal(run({ over: { [name]: 'skipped' } }).status, 1, name);
});

test('a documentation-only change skips every code job and the gate passes', () => {
  const over = Object.fromEntries(NEEDED.filter((n) => n !== 'changes' && n !== 'checks').map((n) => [n, 'skipped']));
  assert.equal(run({ code: 'false', semantic: 'false', search: 'false', over }).status, 0);
});

test('says which job failed', () => {
  const r = run({ over: { 'e2e-web-browsers': 'failure' } });
  assert.match(r.out, /FAIL e2e-web-browsers \(result=failure\)/);
  assert.match(run({ search: 'false', over: { 'search-latency': 'skipped' } }).out, /SKIP search-latency/);
});
