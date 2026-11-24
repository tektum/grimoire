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

test('it runs check:build on a production build (an e2e build has the development sign-in, which it refuses), then builds in e2e mode, and starts the stack with the handshake required', () => {
  const production = steps.findIndex((l) => /vite build && bun run check:build$/.test(l));
  const e2e = at(/vite build --mode e2e/);
  assert.ok(production > 0, 'a production build with the check after it');
  assert.ok(e2e > production, 'the e2e build comes after the check, so that the stack is tried against it');
  assert.equal(steps.filter((l) => /check:build/.test(l)).length, 1, 'the check runs once, and on no e2e build');
  const up = steps[at(/ up$/)] ?? '';
  assert.match(up, /M6_REQUIRE_HANDSHAKE=1/);
  assert.match(up, /COMPOSE_FILE=compose\.yaml:compose\.m6\.yaml/);
});

test('it renders the headers once, in a line of its own that stops the run when it fails, and serves both runs with that folder', () => {
  const render = steps.findIndex((l) => /^bun run apps\/web\/test-e2e\/m6\/headers\.ts$/.test(l));
  const runs = steps.filter((l) => /bunx playwright test/.test(l));
  assert.ok(render > at(/files-setup/), 'after the stack is up, which the headers are rendered for');
  assert.equal(steps.filter((l) => /m6\/headers\.ts/.test(l)).length, 1, 'once');
  assert.ok(render < steps.findIndex((l) => /bunx playwright test/.test(l)), 'before the first run');
  assert.equal(runs.length, 2);
  for (const run of runs) assert.match(run, /GRIMOIRE_WEB_HEADERS_DIR="\/[^"]*\/test-results\/m6-headers"/, 'an absolute folder: the server of the run starts in apps/web');
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
