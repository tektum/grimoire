import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (path) => readFileSync(`${root}${path}`, 'utf8');
const ci = read('.github/workflows/ci.yml');

/** The text of one top-level job of ci.yml: from its name line to the next job's. */
function job(name) {
  const start = ci.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `ci.yml has a job ${name}`);
  const rest = ci.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z0-9-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next + 2);
}
const line = (text, key) => text.split('\n').find((l) => l.trim().startsWith(`${key}:`))?.trim();

const chromium = job('e2e-web');
const browsers = job('e2e-web-browsers');

test('the Firefox and WebKit job is a matrix of exactly those two browsers, and one failing does not stop the other', () => {
  assert.match(browsers, /strategy:\n {6}fail-fast: false\n {6}matrix:\n {8}browser: \[firefox, webkit\]\n/);
});

test('it has the runner, the condition and the pinned actions of the Chromium job', () => {
  assert.equal(line(browsers, 'if'), line(chromium, 'if'));
  const runner = (text) => /runner=([^/']+)\/spot=([a-z]+)/.exec(line(text, 'runs-on') ?? '')?.slice(1, 3).join(' ');
  assert.equal(runner(browsers), runner(chromium));
  assert.equal(runner(browsers), '4cpu-linux-x64 false');
  assert.match(line(browsers, 'runs-on') ?? '', /matrix\.browser/, 'a runner of its own for each browser');
  const uses = [...browsers.matchAll(/uses: (\S+)/g)].map((m) => m[1]);
  assert.ok(uses.length >= 4);
  for (const u of uses) assert.match(u, /@[0-9a-f]{40}$/, `${u} is pinned to a commit`);
  assert.deepEqual([...browsers.matchAll(/uses: ([^@\s]+)@/g)].map((m) => m[1]).filter((u) => u !== 'actions/cache'), [...chromium.matchAll(/uses: ([^@\s]+)@/g)].map((m) => m[1]).filter((u) => u !== 'actions/cache'));
});

test('it installs its browser with its system libraries, caches the browsers, runs the target of its browser and keeps what a failure leaves', () => {
  assert.match(browsers, /bunx playwright install --with-deps "\$BROWSER"\n {8}env:\n {10}BROWSER: \$\{\{ matrix\.browser \}\}/);
  assert.match(browsers, /path: ~\/\.cache\/ms-playwright\n {10}key: playwright-\$\{\{ runner\.os \}\}-\$\{\{ matrix\.browser \}\}-\$\{\{ hashFiles\('bun\.lock'\) \}\}/);
  assert.match(browsers, /- run: make test-web-e2e-browser\n {8}env:\n {10}BROWSER: \$\{\{ matrix\.browser \}\}/);
  assert.match(browsers, /if: failure\(\)\n {8}uses: actions\/upload-artifact@[0-9a-f]{40} # v[\d.]+\n {8}with:\n {10}name: e2e-web-results-\$\{\{ matrix\.browser \}\}/);
  assert.match(browsers, /- name: Tear down\n {8}if: always\(\)\n {8}run: make down-volumes/);
});

test('it is not in the merge gate: that is for the owner to change', () => {
  const needs = job('ci-required').split('needs:\n')[1]?.split('steps:')[0] ?? '';
  assert.ok(needs.includes('- e2e-m5'), 'the list of the gate is read');
  assert.ok(!needs.includes('e2e-web'), 'neither web job is in the gate');
});

test('the make target takes its browser from BROWSER, refuses another, and the Makefile itself is not the place of it', () => {
  const mk = read('mk/test-web-browsers.mk');
  assert.match(mk, /^BROWSER \?= chromium$/m);
  assert.match(mk, /case "\$\(BROWSER\)" in chromium\|firefox\|webkit\) ;; \*\) echo .* exit 2/);
  for (const browser of ['firefox', 'webkit']) {
    const dry = spawnSync('make', ['-n', '-C', root, 'test-web-e2e-browser', `BROWSER=${browser}`], { encoding: 'utf8' });
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, new RegExp(`--project=${browser}\\b`));
    assert.doesNotMatch(dry.stdout, /--project=chromium/);
  }
  assert.doesNotMatch(read('Makefile'), /test-web-e2e-browser/);
});
