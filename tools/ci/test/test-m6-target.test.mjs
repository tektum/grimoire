import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

test('it renders the headers once, in a line of its own that stops the run when it fails, and serves the handshake run and the run of the scenarios with that folder, the scripted run without it', () => {
  const render = steps.findIndex((l) => /^bun run apps\/web\/test-e2e\/m6\/headers\.ts$/.test(l));
  const runs = steps.filter((l) => /bunx playwright test/.test(l));
  assert.ok(render > at(/files-setup/), 'after the stack is up, which the headers are rendered for');
  assert.equal(steps.filter((l) => /m6\/headers\.ts/.test(l)).length, 1, 'once');
  assert.ok(render < steps.findIndex((l) => /bunx playwright test/.test(l)), 'before the first run');
  assert.equal(runs.length, 3);
  const [handshake, scenarios, scripted] = runs;
  for (const run of [handshake, scenarios]) assert.match(run, /GRIMOIRE_WEB_HEADERS_DIR="\/[^"]*\/test-results\/m6-headers"/, 'an absolute folder: the server of the run starts in apps/web');
  assert.doesNotMatch(scripted ?? '', /GRIMOIRE_WEB_HEADERS_DIR/, 'the scripted servers sit on ports the production policy does not allow');
  assert.match(scripted ?? '', /scenarios\.ts files scripted/, 'the files are the scripted ones of the list');
  assert.doesNotMatch(scenarios ?? '', /files scripted/);
  assert.match(scripted ?? '', /M6_REQUIRE_HANDSHAKE=1/);
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

// The two targets the merge gate runs (`ci.yml`): what they do, in the order they do it. They are not part of `test-m6` itself (its recipe is pinned above), so the exit test and the gate cannot drift in silence.
const dryOf = (target) => spawnSync('make', ['-n', '-C', root, target], { encoding: 'utf8' });
const stepsOf = (run) => run.stdout.split('\n').filter((l) => l.trim() !== '' && !/^make(\[\d+\])?: /.test(l));

test('`test-m6-static` checks the list of scenarios, then builds the client for production and checks that build, and starts nothing', () => {
  const run = dryOf('test-m6-static');
  assert.equal(run.status, 0, run.stderr);
  const lines = stepsOf(run);
  assert.equal(lines.length, 2);
  assert.match(lines[0] ?? '', /m6\/scenarios\.ts check$/);
  assert.match(lines[1] ?? '', /vite build && bun run check:build$/);
  assert.doesNotMatch(run.stdout, /--mode e2e|docker|playwright| up$/);
});

test('`test-m6-handshake` starts the stack with the handshake required, renders the headers once, and runs the handshake check and the check of the served headers in Chromium alone, with the exit test settings', () => {
  const run = dryOf('test-m6-handshake');
  assert.equal(run.status, 0, run.stderr);
  const lines = stepsOf(run);
  const up = lines.findIndex((l) => / up$/.test(l));
  const files = lines.findIndex((l) => /files-setup/.test(l));
  const headers = lines.findIndex((l) => /^bun run apps\/web\/test-e2e\/m6\/headers\.ts$/.test(l));
  const spec = lines.findIndex((l) => /bunx playwright test/.test(l));
  assert.ok(up >= 0 && files > up && headers > files && spec > headers, 'the stack, its bucket, the headers, then the check');
  assert.match(lines[up] ?? '', /M6_REQUIRE_HANDSHAKE=1/);
  assert.match(lines[up] ?? '', /COMPOSE_FILE=compose\.yaml:compose\.m6\.yaml/);
  assert.match(lines[spec] ?? '', /M6_EXIT=1/);
  assert.match(lines[spec] ?? '', /M6_REQUIRE_HANDSHAKE=1/);
  assert.match(lines[spec] ?? '', /GRIMOIRE_WEB_HEADERS_DIR="\/[^"]*\/test-results\/m6-headers"/);
  assert.match(lines[spec] ?? '', /--project=chromium apps\/web\/test-e2e\/m6\/handshake\.spec\.ts apps\/web\/test-e2e\/m6\/origins\.spec\.ts$/, 'the handshake check and the one that asserts the page served with its headers');
  assert.equal(lines.filter((l) => /bunx playwright test/.test(l)).length, 1, 'one run, one browser');
});

test('the browsers are installed by the line `M6_BROWSER_INSTALL` says: the default is the install with its apt step, and a job that installed them already turns it into a no-op', () => {
  const plain = stepsOf(dryOf('test-m6'));
  assert.ok(plain.some((l) => /^bunx playwright install --with-deps chromium firefox webkit$/.test(l)), 'by default, the install');
  const run = spawnSync('make', ['-n', '-C', root, 'test-m6', 'M6_BROWSER_INSTALL=true'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const lines = stepsOf(run);
  assert.ok(lines.includes('true'), 'the install line is the one given');
  assert.ok(!lines.some((l) => /playwright install/.test(l)), 'no second install');
  assert.ok(lines.findIndex((l) => l === 'true') < lines.findIndex((l) => /m6\/scenarios\.ts check/.test(l)), 'in the place of the install: before the checks');
});

test('the built client is told the address the headers are rendered for, after the e2e build and before the stack and the runs, and the scenario runs stop after three failures', () => {
  const build = at(/vite build --mode e2e/);
  const config = at(/m6\/client-config\.ts/);
  const render = at(/m6\/headers\.ts/);
  assert.ok(config === build + 1, 'right after the e2e build (which copies the config that names localhost)');
  assert.ok(config < render && config < at(/bunx playwright test/), 'before the headers and the runs');
  for (const run of steps.filter((l) => /scenarios\.ts files/.test(l))) assert.match(run, / --max-failures=3 /, 'a broken run ends in minutes, not at the job limit');
});

test('client-config.ts writes the address of apiUrl() (E2E_API_URL, the one the headers are rendered for) and keeps the other keys', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'client-config-'));
  try {
    const file = path.join(dir, 'config.json');
    writeFileSync(file, '{"apiUrl":"http://localhost:8080","other":1}');
    const run = spawnSync('bun', ['run', `${root}apps/web/test-e2e/m6/client-config.ts`, file], { encoding: 'utf8', env: { ...process.env, E2E_API_URL: 'http://127.0.0.1:9999/' } });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { apiUrl: 'http://127.0.0.1:9999', other: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
