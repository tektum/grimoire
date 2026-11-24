import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const dry = spawnSync('make', ['-n', '-C', root, 'test-m6'], { encoding: 'utf8' });
const steps = dry.stdout.split('\n').filter((l) => l.trim() !== '');
const at = (pattern) => steps.findIndex((l) => pattern.test(l));

test('the exit test is a target of its own file, and the Makefile does not change for it', () => {
  assert.equal(dry.status, 0, dry.stderr);
  assert.doesNotMatch(readFileSync(`${root}Makefile`, 'utf8'), /test-m6/);
  assert.match(readFileSync(`${root}mk/test-m6.mk`, 'utf8'), /^test-m6: dev-secret$/m);
});

test('it checks the browsers and the list of scenarios before it builds or starts anything', () => {
  const check = at(/support\/run-check\.ts/);
  const list = at(/m6\/scenarios\.ts check/);
  const build = at(/bun run build/);
  const stack = at(/ up$/);
  assert.ok(check > 0 && list > check, 'the browser check, then the list');
  assert.ok(build > list && stack > build, 'the build and the stack come after both');
  assert.match(steps[check - 1] ?? '', /playwright install --with-deps chromium firefox webkit/, 'it tries to install the browsers first');
});

test('it builds in e2e mode, runs check:build, and starts the stack with the handshake required', () => {
  assert.ok(at(/vite build --mode e2e/) > 0);
  assert.ok(at(/check:build/) > at(/vite build --mode e2e/));
  const up = steps[at(/ up$/)] ?? '';
  assert.match(up, /M6_REQUIRE_HANDSHAKE=1/);
  assert.match(up, /COMPOSE_FILE=compose\.yaml:compose\.m6\.yaml/);
});

test('it serves the client with the headers rendered for the running stack, in both runs of the specifications', () => {
  const runs = steps.filter((l) => /bunx playwright test/.test(l));
  assert.equal(runs.length, 2);
  for (const run of runs) assert.match(run, /GRIMOIRE_WEB_HEADERS_DIR="\$\(bun run apps\/web\/test-e2e\/m6\/headers\.ts\)"/);
});

test('it runs the handshake check on its own first, then the scenarios in the three browsers', () => {
  const first = at(/--project=chromium apps\/web\/test-e2e\/m6\/handshake\.spec\.ts/);
  const all = steps.findIndex((l) => /--project=chromium --project=firefox --project=webkit/.test(l));
  assert.ok(first > at(/files-setup/), 'after the stack is up');
  assert.ok(all > first, 'the run of the scenarios follows');
  assert.match(steps[all] ?? '', /scenarios\.ts files/, 'the files are those of the list');
  for (const line of [steps[first], steps[all]]) assert.match(line ?? '', /M6_REQUIRE_HANDSHAKE=1/);
});

test('with the browsers absent, the check of the run stops it with the plain line', () => {
  const run = spawnSync('bun', ['run', 'apps/web/test-e2e/support/run-check.ts'], { cwd: root, encoding: 'utf8', env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: '/nonexistent-browsers' } });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /^playwright browsers missing: run bunx playwright install --with-deps chromium firefox webkit$/m);
});
